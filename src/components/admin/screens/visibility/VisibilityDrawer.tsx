import { useEffect, useId, useState } from 'react';
import Drawer from '@/components/admin/kit/Drawer';
import Icon from '@/components/admin/kit/Icon';
import Note from '@/components/admin/kit/Note';
import type { IconName } from '@/lib/admin/icons';
import {
  APPLIES_WITHIN,
  HIDDEN_NOTE,
  HOME_REFUSAL,
  MODE_COPY,
  PASSWORD_HINT,
  PASSWORD_MESSAGE_LABEL,
  PASSWORD_NOTE,
  PASSWORD_REQUIRED,
  TEMPLATE_NOTE,
} from '@/lib/admin/visibilityCopy';
import { PAGE_NOTE_MAX, PAGE_PASSWORD_BYTES, passwordBytes } from '@schemas/visibility';
import { itemTitle } from './VisibilityList';
import type { VisibilityItem, VisibilityMode } from './types';

// "Who can see <page>?" (Admin v2 U14a; the prototype's visibilityDrawer): the modes as a
// real radio group (a fieldset with its legend, the prototype's rows restyled as labels), a
// hidden page's extras (where its old link sends visitors, and an optional window of Riyadh
// days), a password page's extras (U14b: the password, and the bilingual line above the
// box), the template note, and Apply.
//
// The password lives in this component's state while the drawer is open and is sent once.
// Nothing reads it back, because nothing can: the database keeps a bcrypt hash and no path
// returns it (0061). So the field is never pre-filled, and a page that already has a
// password still asks for one to change its message.

export interface VisibilityDraft {
  mode: VisibilityMode;
  /** A page id, '' for a "page not found" screen. */
  redirect: string;
  hideFrom: string;
  showOn: string;
  /** Password mode: what was just typed. Never loaded, never echoed back. */
  password: string;
  noteEn: string;
  noteAr: string;
}

const ICON: Record<VisibilityMode, IconName> = {
  public: 'globe',
  hidden: 'eyeoff',
  link: 'link',
  password: 'lock',
};

/** Where a hidden page sends its visitors: the homepage first, then the other pages. */
export interface RedirectChoice {
  id: string;
  label: string;
}

export function draftOf(item: VisibilityItem, homeId: string | null): VisibilityDraft {
  const setting = item.setting;
  const mode = setting?.mode ?? 'public';
  return {
    mode,
    // A page being hidden for the first time sends its visitors home (the prototype's default).
    redirect: mode === 'hidden' ? (setting?.redirectPageId ?? '') : (homeId ?? ''),
    hideFrom: setting?.hideFrom ?? '',
    showOn: setting?.showOn ?? '',
    password: '',
    noteEn: setting?.note?.en ?? '',
    noteAr: setting?.note?.ar ?? '',
  };
}

/** Whether what is typed can be applied: the password mode needs a usable password. */
export function draftReady(draft: VisibilityDraft): boolean {
  if (draft.mode !== 'password') return true;
  const bytes = passwordBytes(draft.password);
  return bytes >= PAGE_PASSWORD_BYTES.min && bytes <= PAGE_PASSWORD_BYTES.max;
}

export default function VisibilityDrawer({
  item,
  choices,
  busy,
  error,
  onClose,
  onApply,
}: {
  item: VisibilityItem | null;
  choices: readonly RedirectChoice[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onApply: (draft: VisibilityDraft) => void;
}) {
  const homeId = choices[0]?.id ?? null;
  const [draft, setDraft] = useState<VisibilityDraft | null>(() =>
    item ? draftOf(item, homeId) : null,
  );
  const ids = {
    redirect: useId(),
    from: useId(),
    until: useId(),
    dates: useId(),
    password: useId(),
    passwordHint: useId(),
    message: useId(),
    noteEn: useId(),
    noteAr: useId(),
  };
  const [shown, setShown] = useState(false);

  useEffect(() => {
    setDraft(item ? draftOf(item, homeId) : null);
  }, [item, homeId]);

  const isHome = item?.kind === 'page' && item.slug === 'home';
  // A template renders many pages, so it takes public or hidden only (decision D1): a
  // template-wide password would need a fence on `services` and `portfolio`, which the
  // listing pages read.
  const modes: VisibilityMode[] =
    item?.kind === 'template' ? ['public', 'hidden'] : ['public', 'hidden', 'link', 'password'];
  const set = (patch: Partial<VisibilityDraft>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));
  const ordered = Boolean(draft?.hideFrom && draft.showOn && draft.showOn <= draft.hideFrom);
  const title = item ? itemTitle(item) : '';
  const hadPassword = item?.setting?.mode === 'password';
  const ready = draft === null || draftReady(draft);

  return (
    <Drawer
      open={item !== null}
      onClose={onClose}
      title={`Who can see ${title}?`}
      dismissible={false}
      footer={
        <>
          <button type="button" className="btn" data-variant="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            data-variant="primary"
            disabled={busy || draft === null || ordered || !ready}
            onClick={() => draft && onApply(draft)}
          >
            <Icon name="check" size={16} />
            Apply
          </button>
        </>
      }
    >
      {item && draft && (
        <div className="vis-drawer">
          <p className="admin-sub">{APPLIES_WITHIN}</p>
          {error && (
            <Note tone="err" role="alert">
              {error}
            </Note>
          )}
          {isHome && <Note>{HOME_REFUSAL}</Note>}
          <fieldset className="vis-opts">
            <legend className="visually-hidden">Who can see {title}</legend>
            {modes.map((mode) => (
              <label key={mode} className="li vis-opt">
                <input
                  type="radio"
                  name="vis-mode"
                  value={mode}
                  checked={draft.mode === mode}
                  disabled={isHome && mode !== 'public'}
                  onChange={() => set({ mode })}
                />
                <span className="li__ico">
                  <Icon name={ICON[mode]} />
                </span>
                <span className="li__main">
                  <span className="li__t">{MODE_COPY[mode].title}</span>
                  <span className="li__s">{MODE_COPY[mode].text}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {draft.mode === 'hidden' && (
            <div className="vis-extra">
              <div className="field">
                <label className="vis-label" htmlFor={ids.redirect}>
                  Send visitors of the old link to
                </label>
                <select
                  id={ids.redirect}
                  value={draft.redirect}
                  onChange={(event) => set({ redirect: event.target.value })}
                >
                  {choices
                    .filter((choice) => item.kind !== 'page' || choice.id !== item.id)
                    .map((choice, index) => (
                      <option key={choice.id} value={choice.id}>
                        {index === 0 && choice.id === homeId ? 'The homepage' : choice.label}
                      </option>
                    ))}
                  <option value="">A “page not found” screen</option>
                </select>
              </div>
              <div className="vis-dates" role="group" aria-describedby={ids.dates}>
                <div className="field">
                  <label className="vis-label" htmlFor={ids.from}>
                    Hide from (optional)
                  </label>
                  <input
                    id={ids.from}
                    type="date"
                    value={draft.hideFrom}
                    onChange={(event) => set({ hideFrom: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label className="vis-label" htmlFor={ids.until}>
                    Show again on (optional)
                  </label>
                  <input
                    id={ids.until}
                    type="date"
                    value={draft.showOn}
                    aria-invalid={ordered ? 'true' : undefined}
                    onChange={(event) => set({ showOn: event.target.value })}
                  />
                </div>
              </div>
              <p id={ids.dates} className="admin-sub">
                Leave the dates empty to hide it right away, until you show it again. Days are
                Riyadh days.
              </p>
              {ordered && (
                <Note tone="err" role="alert">
                  Show again on must be after Hide from.
                </Note>
              )}
              <Note>{HIDDEN_NOTE}</Note>
            </div>
          )}

          {draft.mode === 'password' && (
            <div className="vis-extra">
              <div className="field">
                <label className="vis-label" htmlFor={ids.password}>
                  Password
                </label>
                <div className="vis-secret">
                  <input
                    id={ids.password}
                    type={shown ? 'text' : 'password'}
                    value={draft.password}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={200}
                    aria-describedby={ids.passwordHint}
                    onChange={(event) => set({ password: event.target.value })}
                  />
                  <button
                    type="button"
                    className="btn"
                    data-variant="ghost"
                    aria-pressed={shown}
                    onClick={() => setShown((value) => !value)}
                  >
                    <Icon name={shown ? 'eyeoff' : 'eye'} size={16} />
                    {shown ? 'Hide' : 'Show'}
                  </button>
                </div>
                <p id={ids.passwordHint} className="admin-sub">
                  {PASSWORD_HINT} At least {PAGE_PASSWORD_BYTES.min} characters.
                </p>
              </div>
              {hadPassword && <Note>{PASSWORD_REQUIRED}</Note>}
              <p className="vis-label" id={ids.message}>
                {PASSWORD_MESSAGE_LABEL}
              </p>
              <div className="vis-dates" role="group" aria-labelledby={ids.message}>
                <div className="field">
                  <label className="vis-label" htmlFor={ids.noteEn}>
                    English (optional)
                  </label>
                  <input
                    id={ids.noteEn}
                    type="text"
                    value={draft.noteEn}
                    maxLength={PAGE_NOTE_MAX}
                    onChange={(event) => set({ noteEn: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label className="vis-label" htmlFor={ids.noteAr}>
                    Arabic (optional)
                  </label>
                  <input
                    id={ids.noteAr}
                    type="text"
                    dir="rtl"
                    value={draft.noteAr}
                    maxLength={PAGE_NOTE_MAX}
                    onChange={(event) => set({ noteAr: event.target.value })}
                  />
                </div>
              </div>
              <Note>{PASSWORD_NOTE}</Note>
            </div>
          )}

          {item.kind === 'template' && <Note>{TEMPLATE_NOTE[item.template]}</Note>}
        </div>
      )}
    </Drawer>
  );
}
