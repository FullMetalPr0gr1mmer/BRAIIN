import { MAX_CLIP_SECONDS } from '@schemas/media';
import { SITE_CLIPS } from '@/lib/media/clips';
import type { ClipState } from '@/lib/admin/formPayload';
import type { FieldErrors } from '@/lib/admin/fieldErrors';
import type { FieldDef } from '@/lib/admin/uiSchema';
import FieldShell, { FieldErrorText, describedBy } from './FieldShell';

// A video clip (VideoClipSchema in packages/schemas/media.ts): EITHER a Cloudflare Stream
// UID OR a self-hosted `/media/….mp4` path (EXC-009, until Stream lands — KAN-20), plus
// an optional window of at most 30 s. The server enforces all of that; this makes the
// either/or impossible to get wrong in the UI.
//
// v2 (Admin v2 F5b, ui.md §2.6 "clip v2"): the site file is PICKED from the code registry
// (src/lib/media/clips.ts), which knows how long each file is — so the window can be shown
// as what it is, "6.2 s to 7.9 s of showreel.mp4 (18.4 s)", on a timeline drawn with SVG
// geometry (no style attribute: §3 Pillar 1), and a window that runs past the end of the
// video or past the 30 s rule is said in words before the save is refused. The drawing is
// aria-hidden; the line beside it carries the same thing in words.

interface Props {
  field: FieldDef;
  value: unknown;
  onChange: (name: string, value: unknown) => void;
  idPrefix: string;
  errors?: FieldErrors | undefined;
}

const EMPTY: ClipState = { source: '', streamUid: '', path: '', startS: '', endS: '' };

/** A number as an editor reads it: "18.4", "7" — never a float's tail. */
const seconds = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(1);

export default function ClipField({ field, value, onChange, idPrefix, errors }: Props) {
  const state = { ...EMPTY, ...((value ?? {}) as Partial<ClipState>) };
  const id = `${idPrefix}-${field.name}`;
  const set = (patch: Partial<ClipState>) => onChange(field.name, { ...state, ...patch });
  const error = errors?.[id];
  /** aria-invalid and aria-describedby for one of the clip's own inputs. */
  const marked = (input: string) => {
    const message = errors?.[`${id}-${input}`];
    return {
      'aria-invalid': message ? true : undefined,
      'aria-describedby': describedBy(`${id}-${input}`, { error: message }),
    };
  };

  const clip = SITE_CLIPS.find((entry) => entry.path === state.path);
  const start = Number(state.startS);
  const end = Number(state.endS);
  const window =
    state.startS.trim() !== '' &&
    state.endS.trim() !== '' &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end > start
      ? { start, end }
      : null;
  const tooLong = window !== null && window.end - window.start > MAX_CLIP_SECONDS;
  const pastEnd = window !== null && clip !== undefined && window.end > clip.durationS;

  // The timeline: the whole file, and the window inside it. Percentages of a 100-wide
  // viewBox, so the geometry is attributes and the width is the stylesheet's.
  const bar =
    clip && window
      ? {
          x: Math.max(0, Math.min(100, (window.start / clip.durationS) * 100)),
          width: Math.max(
            1.5,
            Math.min(
              100,
              ((Math.min(window.end, clip.durationS) - window.start) / clip.durationS) * 100,
            ),
          ),
        }
      : null;

  return (
    <FieldShell
      as="fieldset"
      id={id}
      label={field.label}
      hint={
        field.help ??
        `A window plays that part of the video on a loop, for at most ${MAX_CLIP_SECONDS} seconds. Leave both empty for the whole video.`
      }
      error={error}
    >
      <div className="row-3">
        {(
          [
            ['', 'No video'],
            ['stream', 'Cloudflare Stream'],
            ['path', 'Site file (/media/…)'],
          ] as const
        )
          // A table with no Stream-uid column yet (0028) offers only the site file — a stored
          // Stream clip would still show, so it can be switched away from.
          .filter(
            ([source]) => !(field.pathOnly && source === 'stream' && state.source !== 'stream'),
          )
          .map(([source, label]) => (
            <label key={source || 'none'} className="field field-inline">
              <input
                type="radio"
                name={`${id}-source`}
                checked={state.source === source}
                onChange={() => set({ source })}
              />
              <span>{label}</span>
            </label>
          ))}
      </div>
      {state.source === 'stream' && (
        <label className="field" htmlFor={`${id}-uid`}>
          <span>Stream UID *</span>
          <input
            id={`${id}-uid`}
            {...marked('uid')}
            type="text"
            value={state.streamUid}
            onChange={(e) => set({ streamUid: e.target.value })}
          />
        </label>
      )}
      {state.source === 'path' && (
        <label className="field" htmlFor={`${id}-path`}>
          <span>Video *</span>
          <select
            id={`${id}-path`}
            {...marked('path')}
            value={state.path}
            onChange={(e) => set({ path: e.target.value })}
          >
            <option value="">Not set</option>
            {/* A stored path the site no longer has stays selectable, so it can be seen
                and changed rather than silently becoming "not set". */}
            {state.path !== '' && !clip && <option value={state.path}>{state.path}</option>}
            {SITE_CLIPS.map((entry) => (
              <option key={entry.path} value={entry.path}>
                {entry.name} ({seconds(entry.durationS)} s)
              </option>
            ))}
          </select>
        </label>
      )}
      {state.source !== '' && (
        <div className="row-2">
          <label className="field" htmlFor={`${id}-start`}>
            <span>Start (seconds)</span>
            <input
              id={`${id}-start`}
              {...marked('start')}
              type="number"
              min="0"
              max={clip ? seconds(clip.durationS) : undefined}
              step="0.1"
              className="in--num"
              data-label={`${field.label} start`}
              value={state.startS}
              onChange={(e) => set({ startS: e.target.value })}
            />
          </label>
          <label className="field" htmlFor={`${id}-end`}>
            <span>End (seconds)</span>
            <input
              id={`${id}-end`}
              {...marked('end')}
              type="number"
              min="0"
              max={clip ? seconds(clip.durationS) : undefined}
              step="0.1"
              className="in--num"
              data-label={`${field.label} end`}
              value={state.endS}
              onChange={(e) => set({ endS: e.target.value })}
            />
          </label>
        </div>
      )}
      {clip && (
        <div className="clipf">
          {bar && (
            <svg
              className="clipf__line"
              viewBox="0 0 100 10"
              preserveAspectRatio="none"
              aria-hidden="true"
              focusable="false"
            >
              <rect className="clipf__all" x="0" y="3" width="100" height="4" rx="2" />
              <rect className="clipf__win" x={bar.x} y="1" width={bar.width} height="8" rx="2" />
            </svg>
          )}
          <p className="clipf__says">
            {window
              ? `${seconds(window.start)} s to ${seconds(window.end)} s of ${clip.name} (${seconds(clip.durationS)} s)`
              : `The whole of ${clip.name} (${seconds(clip.durationS)} s)`}
          </p>
          {tooLong && (
            <p className="field-error f__err">
              That window is {seconds(window.end - window.start)} s. A clip plays at most{' '}
              {MAX_CLIP_SECONDS} seconds.
            </p>
          )}
          {pastEnd && (
            <p className="field-error f__err">
              The video ends at {seconds(clip.durationS)} s, so the end is past it.
            </p>
          )}
        </div>
      )}
      {/* The field's own error is FieldShell's; these are its inputs' own. */}
      {(['uid', 'path', 'start', 'end'] as const).map((input) => (
        <FieldErrorText key={input} id={`${id}-${input}`} message={errors?.[`${id}-${input}`]} />
      ))}
    </FieldShell>
  );
}
