import { useRef, type FormEvent, type ReactNode } from 'react';
import ErrorSummary from '@/components/admin/kit/ErrorSummary';
import SaveStatus from '@/components/admin/kit/SaveStatus';
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
//   - `children` (a screen's own notes, such as the edge warning), then the fields;
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
}: EditorFormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  // Ctrl/⌘+S saves this form when it has changes, unless focus is in another editor on the
  // page (General settings shows two): each shortcut press saves one form, the one in use.
  useSaveShortcut(() => {
    const active = document.activeElement;
    const other = active?.closest('form.editor');
    if (other && other !== formRef.current) return;
    if (save.dirty) void save.save();
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
    void save.save();
  };

  const form = (
    // noValidate: an input of the hidden language must never block a save silently (a
    // browser cannot show its bubble on a hidden input); the server validates, and its
    // answer lands on the fields.
    <form ref={formRef} className="editor" noValidate onSubmit={onSubmit}>
      <ErrorSummary errors={save.errors.summary} />
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
        {fields.map((field) => (
          <Field
            key={field.name}
            field={field}
            value={save.values[field.name]}
            values={save.values}
            onChange={save.set}
            errors={save.errors.byId}
            canAdvanced={canAdvanced}
          />
        ))}
      </div>

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
