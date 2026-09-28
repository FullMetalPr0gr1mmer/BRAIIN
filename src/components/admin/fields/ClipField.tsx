import type { ClipState } from '@/lib/admin/formPayload';
import type { FieldDef } from '@/lib/admin/uiSchema';

// A video clip (VideoClipSchema in packages/schemas/media.ts): EITHER a Cloudflare Stream
// UID OR a self-hosted `/media/….mp4` path (EXC-009, until Stream lands — KAN-20), plus
// an optional window of at most 30s. The server enforces all of that; this makes the
// either/or impossible to get wrong in the UI.

interface Props {
  field: FieldDef;
  value: unknown;
  onChange: (name: string, value: unknown) => void;
  idPrefix: string;
}

const EMPTY: ClipState = { source: '', streamUid: '', path: '', startS: '', endS: '' };

export default function ClipField({ field, value, onChange, idPrefix }: Props) {
  const state = { ...EMPTY, ...((value ?? {}) as Partial<ClipState>) };
  const id = `${idPrefix}-${field.name}`;
  const set = (patch: Partial<ClipState>) => onChange(field.name, { ...state, ...patch });

  return (
    <fieldset className="field-group">
      <legend className="field-legend">{field.label}</legend>
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
            type="text"
            value={state.streamUid}
            onChange={(e) => set({ streamUid: e.target.value })}
          />
        </label>
      )}
      {state.source === 'path' && (
        <label className="field" htmlFor={`${id}-path`}>
          <span>Path *</span>
          <input
            id={`${id}-path`}
            type="text"
            placeholder="/media/showreel.mp4"
            value={state.path}
            onChange={(e) => set({ path: e.target.value })}
          />
        </label>
      )}
      {state.source !== '' && (
        <div className="row-2">
          <label className="field" htmlFor={`${id}-start`}>
            <span>Start (seconds)</span>
            <input
              id={`${id}-start`}
              type="number"
              min="0"
              step="0.1"
              value={state.startS}
              onChange={(e) => set({ startS: e.target.value })}
            />
          </label>
          <label className="field" htmlFor={`${id}-end`}>
            <span>End (seconds)</span>
            <input
              id={`${id}-end`}
              type="number"
              min="0"
              step="0.1"
              value={state.endS}
              onChange={(e) => set({ endS: e.target.value })}
            />
          </label>
        </div>
      )}
      <p className="admin-sub">
        {field.help ??
          'A window plays that part of the video on a loop — at most 30 seconds. Leave both empty for the whole video.'}
      </p>
    </fieldset>
  );
}
