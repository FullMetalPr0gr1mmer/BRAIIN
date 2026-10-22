import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import ErrorSummary from '@/components/admin/kit/ErrorSummary';
import SaveStatus from '@/components/admin/kit/SaveStatus';
import { badInputErrors, type MappedErrors } from '@/lib/admin/fieldErrors';
import type { EntitySave } from '@/lib/admin/useEntitySave';
import { useSaveShortcut } from '@/lib/admin/useEntitySave';
import type { FieldDef } from '@/lib/admin/uiSchema';
import { Field } from '../FormField';
import {
  ArabicGapsProvider,
  ArabicMissingBar,
  EditorLanguageProvider,
  EditorLanguageSwitch,
} from './editorLanguage';

// An editor's form (Admin v2 F5a): what every editor screen draws around its fields, so
// they all read and behave the same. In order:
//   - why the last save was refused: the ErrorSummary (first in the form, focused, each
//     error linked to its field, a hidden one revealed first), a line for a refusal that
//     is not about one field, and the 409 banner with "Reload their version";
//   - the language bar when any field is bilingual: English / العربية / Both for the whole
//     form, and "Arabic missing: N" with "Next gap";
//   - `children` (a screen's own notes, such as the edge warning), then the fields, in one
//     card (with `heading`, the card's header band: the prototype's `card(title, sub)`);
//   - the action bar: Save (Ctrl/⌘+S too), the way back, where the save stands
//     (SaveStatus) and the version ("Not saved yet" for a singleton never saved).
// It takes the save from useEntitySave and holds no save state of its own.

export interface EditorFormProps {
  save: EntitySave;
  fields: readonly FieldDef[];
  submitLabel: string;
  back?: { href: string; label: string } | undefined;
  /** F5b: "Advanced (JSON)" on section content is offered (Admin, D5). */
  canAdvanced?: boolean | undefined;
  children?: ReactNode;
  /**
   * Admin v2 U10: what follows the fields and comes before the action bar (the SEO panel's
   * Index switch, its Advanced section and its previews). Inside the form, so a press of
   * Enter in it still saves.
   */
  after?: ReactNode;
  /**
   * Admin v2 U11: the fields' card's header (the prototype's `.card__h`: a title, an h2 under
   * the page's h1, and a line under it), for a screen whose form is one named card.
   */
  heading?: { title: string; sub?: string | undefined } | undefined;
}

const LANGUAGE_KINDS = new Set(['bilingual', 'prose', 'richtext']);

/** True when a field, or one inside it, has an Arabic half. */
function hasBilingual(fields: readonly FieldDef[]): boolean {
  return fields.some(
    (f) =>
      LANGUAGE_KINDS.has(f.kind) ||
      (f.kind === 'chips' && f.chips?.bilingual === true) ||
      f.kind === 'sectionContent' ||
      (f.itemFields !== undefined && hasBilingual(f.itemFields)),
  );
}

export default function EditorForm({
  save,
  fields,
  submitLabel,
  back,
  canAdvanced,
  children,
  after,
  heading,
}: EditorFormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  // Errors found here before anything is sent (a number or a date the browser could not
  // read): shown like the server's, cleared by the next attempt.
  const [local, setLocal] = useState<MappedErrors | null>(null);

  /**
   * Saves, unless a number or date-and-time box holds text the browser could not read.
   * noValidate (below) turned off the browser's own block, and such a box reports '' to
   * script, which would be sent as "no value" and clear the stored one (a schedule, a
   * sort order). So those boxes are read here and the save refused with their names.
   */
  function submit() {
    const form = formRef.current;
    const unreadable = form
      ? [
          ...form.querySelectorAll<HTMLInputElement>(
            'input[type="number"], input[type="datetime-local"]',
          ),
        ]
          .filter((input) => input.validity.badInput)
          .map((input) => ({ id: input.id, type: input.type, label: input.dataset['label'] ?? '' }))
      : [];
    if (unreadable.length > 0) {
      setLocal(badInputErrors(unreadable));
      return;
    }
    setLocal(null);
    void save.save();
  }

  // Ctrl/⌘+S saves this form when it has changes and is the one in use: focus is in it, or
  // focus is in no form and it is the page's only editor (General settings shows two, and
  // one press must never save a form nobody was looking at). A box being typed in is let
  // go first, synchronously, so what it holds (a chip not yet added) is in the save.
  useSaveShortcut(() => {
    const form = formRef.current;
    if (!form) return;
    const active = document.activeElement;
    const inForm = active instanceof HTMLElement && form.contains(active);
    const onlyEditor = document.querySelectorAll('form.editor').length === 1;
    if (!inForm && !(onlyEditor && !active?.closest('form'))) return;
    if (inForm) {
      flushSync(() => (active as HTMLElement).blur());
      (active as HTMLElement).focus();
    }
    // Not gated on `save.dirty`: that is the last render's, and the blur above may just
    // have changed the form. Saving an unchanged form is harmless (a new version).
    submit();
  });

  if (save.loadError) {
    return (
      <p className="msg" data-kind="error" role="alert">
        {save.loadError}
      </p>
    );
  }
  // Loading the row (busy and not saving): nothing to edit yet.
  if (save.busy && save.status !== 'saving') return <p className="admin-sub">Loading…</p>;

  const bilingual = hasBilingual(fields);
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };
  const errors = local ?? save.errors;

  const form = (
    // noValidate: an input of the hidden language must never block a save silently (a
    // browser cannot show its bubble on a hidden input); the server validates, and its
    // answer lands on the fields.
    <form ref={formRef} className="editor" noValidate onSubmit={onSubmit}>
      <ErrorSummary errors={errors.summary} />
      {save.message && (
        <p className="msg" data-kind="error" role="alert">
          {save.message}
        </p>
      )}
      {save.conflict && (
        <div className="msg editor__conflict" data-kind="error" role="alert">
          <span>Someone else saved changes while you were editing.</span>
          <button type="button" onClick={() => void save.reloadTheirs()}>
            Reload their version
          </button>
        </div>
      )}
      {bilingual && (
        <div className="editor__lang">
          <EditorLanguageSwitch />
          <ArabicMissingBar />
        </div>
      )}
      {children}

      <div className="card">
        {heading && (
          <div className="card__h">
            <div>
              <h2 className="card__t">{heading.title}</h2>
              {heading.sub && <p className="card__sub">{heading.sub}</p>}
            </div>
          </div>
        )}
        {fields.map((field) => (
          <Field
            key={field.name}
            field={field}
            value={save.values[field.name]}
            values={save.values}
            onChange={save.set}
            errors={errors.byId}
            canAdvanced={canAdvanced}
          />
        ))}
      </div>
      {after}

      <div className="toolbar form-actions">
        <button type="submit" data-variant="primary" disabled={save.status === 'saving'}>
          {submitLabel}
        </button>
        {back && (
          <a className="btn" href={back.href}>
            {back.label}
          </a>
        )}
        <SaveStatus state={save.status} savedAt={save.savedAt} />
        {!save.isNew && (
          <span className="admin-sub">
            {save.version === 0 ? 'Not saved yet' : `Version ${save.version}`}
          </span>
        )}
      </div>
    </form>
  );

  return (
    <EditorLanguageProvider>
      <ArabicGapsProvider>{form}</ArabicGapsProvider>
    </EditorLanguageProvider>
  );
}
