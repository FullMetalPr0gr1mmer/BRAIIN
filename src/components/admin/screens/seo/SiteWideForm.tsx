import { useId, useMemo, useRef, useState } from 'react';
import EditorForm from '@/components/admin/fields/EditorForm';
import Modal from '@/components/admin/kit/Modal';
import { singletonHistory } from '@/lib/admin/historyTarget';
import { seoUi } from '@/lib/admin/ui/seo';
import { useEntitySave, type EntitySave } from '@/lib/admin/useEntitySave';

// The Site wide tab of /admin/seo (Admin v2 U10, AV-19): the title template, the default
// title and description, the default share image and the default robots (the
// `seo_defaults` singleton, Admin + SEO). The legacy image link is shown only while one is
// stored, so it can be cleared but never newly set.
//
// Hiding the whole site from search engines asks for typed confirmation (D12): a save that
// moves the robots default from indexed to a noindex value opens a dialog whose button stays
// off until "noindex" is typed. Cancel puts the previous value back.
//
// History (Admin v2 R14-prep): every save of the defaults that went live, and Restore once
// releases are on (R13's drawer; the history names the site, not an id: historyTarget.ts).

export const CONFIRM_WORD = 'noindex';
export const CONFIRM_TITLE = 'Hide the whole site from search engines?';
export const CONFIRM_TEXT = 'This hides every page of the site from search engines.';

const ROBOTS = 'robotsDirectives';
const LEGACY = 'defaultOgImage';

/** The defaults' history: the site's own (no id), previewed on the home page. */
export const DEFAULTS_HISTORY = singletonHistory('seo_defaults');
export const DEFAULTS_HISTORY_OF = { label: 'Site wide SEO', path: '/' } as const;

const noindex = (value: unknown) => typeof value === 'string' && value.startsWith('noindex');

/** True when a save would move the site from indexed to hidden: the dialog asks first. */
export function needsConfirmation(committed: unknown, next: unknown): boolean {
  return noindex(next) && !noindex(committed);
}

export default function SiteWideForm() {
  const target = { kind: 'singleton', endpoint: seoUi.endpoint } as const;
  const save = useEntitySave(target, null, { fields: seoUi.fields });
  const [asking, setAsking] = useState(false);
  const [typed, setTyped] = useState('');
  const inputId = useId();

  // What is saved: the values whenever the form is clean (just loaded, or just saved).
  const committed = useRef<Record<string, unknown>>({});
  if (!save.busy && !save.dirty) committed.current = save.values;

  const legacy = typeof committed.current[LEGACY] === 'string' && committed.current[LEGACY] !== '';
  const shown = useMemo(
    () => seoUi.fields.filter((field) => field.name !== LEGACY || legacy),
    [legacy],
  );

  const guarded: EntitySave = {
    ...save,
    save: async () => {
      if (needsConfirmation(committed.current[ROBOTS], save.values[ROBOTS])) {
        setTyped('');
        setAsking(true);
        return false;
      }
      return save.save();
    },
  };

  // The dialog reports every way it closes (Escape, Close, Cancel) through onClose; only a
  // close that is not the confirmation puts the previous value back.
  const confirmed = useRef(false);
  const onClose = () => {
    setAsking(false);
    if (confirmed.current) {
      confirmed.current = false;
      return;
    }
    save.set(ROBOTS, committed.current[ROBOTS] ?? 'index,follow');
  };

  return (
    <>
      <EditorForm
        save={guarded}
        fields={shown}
        submitLabel="Save site wide settings"
        history={DEFAULTS_HISTORY}
        historyOf={DEFAULTS_HISTORY_OF}
      />
      <Modal
        open={asking}
        onClose={onClose}
        title={CONFIRM_TITLE}
        sub={CONFIRM_TEXT}
        dismissible={false}
        footer={
          <>
            <button type="button" className="btn" data-variant="ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn"
              data-variant="danger"
              disabled={typed.trim() !== CONFIRM_WORD}
              onClick={() => {
                confirmed.current = true;
                setAsking(false);
                void save.save();
              }}
            >
              Hide the site
            </button>
          </>
        }
      >
        <div className="seo-confirm">
          <label htmlFor={inputId}>Type {CONFIRM_WORD} to confirm</label>
          <input
            id={inputId}
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
      </Modal>
    </>
  );
}
