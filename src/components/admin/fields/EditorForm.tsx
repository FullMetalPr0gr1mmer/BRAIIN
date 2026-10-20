import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import ErrorSummary from '@/components/admin/kit/ErrorSummary';
import Note from '@/components/admin/kit/Note';
import SaveStatus from '@/components/admin/kit/SaveStatus';
import { TabStrip, tabIds, writeTabParam } from '@/components/admin/kit/Tabs';
import { tabOfElement, tabsWithErrors } from '@/lib/admin/editorTabs';
import { badInputErrors, type MappedErrors } from '@/lib/admin/fieldErrors';
import type { EntitySave } from '@/lib/admin/useEntitySave';
import { useSaveShortcut } from '@/lib/admin/useEntitySave';
import type { EditorTabDef, FieldDef } from '@/lib/admin/uiSchema';
import { Field, FieldsReadOnly } from '../FormField';
import { useRevealListener } from './reveal';
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
//
// Admin v2 U8b adds two modes, each off unless asked for (without them the output is
// byte for byte what it was; tests/lib/editorForm.spec.ts):
//   - TABS (`tabs`, from ResourceUi.tabs, the API U5 and U6 inherit): the kit's TabStrip
//     above the form; each FIELD tab is a tab panel inside the one form (all mounted, the
//     others hidden, so a save sends every field and nothing typed is lost), each PANEL tab
//     (`panels.seo`, the shared SEO editor) a tab panel AFTER the form, never inside it (it
//     is its own form), and the form is hidden while a panel tab is current. An error link
//     or "Next gap" that names a field in a hidden tab switches to it first (the reveal
//     listener runs in the same turn as the click, so the tab is shown before
//     revealAndFocus's frame focuses the field), and a tab holding an error says so
//     ("Content, has errors" and a dot). `?tab=` follows the tab (replaceState); the server
//     reads it for the first paint (`initialTab`). A panel mounts the first time its tab
//     opens, then stays mounted.
//   - READ-ONLY (`readOnly`, for a role that reads the record without its write
//     capability): the fields inside a disabled <fieldset>, a rich text not editable
//     (FieldsReadOnly), no Save and no Ctrl/⌘+S, and `readOnlyNote` as a note above the
//     fields. UX only: the server refuses a write whatever this shows.
// `publicHref` adds "Open on site" to the action bar when it gives an address, read from the
// record as saved (`save.saved`), never from unsaved edits: choosing Published, or editing a
// published post's slug, links nowhere until it is saved. Field groups
// (U9a) compose inside a field tab: a group renders in its tab's card, never across two tabs.
// The tab API is frozen in docs/admin-v2/as-built/U8.md for U5 and U6.

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
  /** Admin v2 U8b: the editor's tabs (the role's own: see editorTabs.ts visibleTabs). */
  tabs?: readonly EditorTabDef[] | undefined;
  /** The tab list's name ("Post editor"). */
  tabsLabel?: string | undefined;
  /** What each panel tab shows (`panel: 'seo'`: the shared SEO editor, or a note). */
  panels?: Partial<Record<'seo', ReactNode>> | undefined;
  /** The tab to open on: the server's reading of `?tab=` (editorTabs.ts firstTab). */
  initialTab?: string | null | undefined;
  /** Admin v2 U8b: the record can be read, not saved, by this role. */
  readOnly?: boolean | undefined;
  /** What a read-only role is told, above the fields. */
  readOnlyNote?: ReactNode;
  /** The record's public address ("Open on site"), or null; given the saved values. */
  publicHref?: ((values: Readonly<Record<string, unknown>>) => string | null) | undefined;
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
  tabs,
  tabsLabel = 'Editor sections',
  panels,
  initialTab,
  readOnly = false,
  readOnlyNote,
  publicHref,
}: EditorFormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  // Errors found here before anything is sent (a number or a date the browser could not
  // read): shown like the server's, cleared by the next attempt.
  const [local, setLocal] = useState<MappedErrors | null>(null);
  // The tabs (U8b): the current one, and the panel tabs opened so far (mounted from then on).
  const tabBase = useId();
  const [tab, setTab] = useState(
    () => tabs?.find((t) => t.id === initialTab)?.id ?? tabs?.[0]?.id ?? '',
  );
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set([tab]));
  const choose = (id: string) => {
    setTab(id);
    setOpened((seen) => (seen.has(id) ? seen : new Set([...seen, id])));
  };
  // An error link or "Next gap" asks for a field: its tab is shown first, in this turn.
  useRevealListener((id) => {
    if (!tabs) return;
    const holder = tabOfElement(id, tabs, fields);
    if (holder && holder !== tab) {
      choose(holder);
      writeTabParam('tab', holder);
    }
  });

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
    if (!form || readOnly) return;
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
    if (!readOnly) submit();
  };
  const errors = local ?? save.errors;

  const renderField = (field: FieldDef) => (
    <Field
      key={field.name}
      field={field}
      value={save.values[field.name]}
      values={save.values}
      onChange={save.set}
      errors={errors.byId}
      canAdvanced={canAdvanced}
    />
  );

  const fieldTabs = tabs?.filter((t) => !t.panel) ?? [];
  const panelTabs = tabs?.filter((t) => t.panel) ?? [];
  const current = tabs?.find((t) => t.id === tab);
  const flagged = tabs ? tabsWithErrors(errors.byId, tabs, fields) : new Set<string>();

  let fieldBlock: ReactNode = tabs ? (
    fieldTabs.map((t) => {
      const ids = tabIds(tabBase, t.id);
      const own = new Set(t.fields);
      return (
        <div
          key={t.id}
          role="tabpanel"
          id={ids.panel}
          aria-labelledby={ids.tab}
          tabIndex={0}
          data-editor-tab={t.id}
          hidden={t.id !== tab}
        >
          <div className="card">{fields.filter((f) => own.has(f.name)).map(renderField)}</div>
        </div>
      );
    })
  ) : (
    <div className="card">{fields.map(renderField)}</div>
  );
  if (readOnly) {
    // A disabled fieldset turns every control in it off (a rich text is told separately:
    // a contenteditable ignores it).
    fieldBlock = (
      <fieldset className="editor-ro" disabled>
        <legend className="visually-hidden">Read only</legend>
        <FieldsReadOnly.Provider value={true}>{fieldBlock}</FieldsReadOnly.Provider>
      </fieldset>
    );
  }
  // The stored record's address: a new record has none, and an unsaved edit moves nothing.
  const href = save.isNew ? null : (publicHref?.(save.saved) ?? null);

  const form = (
    // noValidate: an input of the hidden language must never block a save silently (a
    // browser cannot show its bubble on a hidden input); the server validates, and its
    // answer lands on the fields.
    <form
      ref={formRef}
      className="editor"
      noValidate
      onSubmit={onSubmit}
      hidden={current?.panel ? true : undefined}
    >
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
      {readOnly && readOnlyNote && <Note tone="info">{readOnlyNote}</Note>}

      {fieldBlock}
      {after}

      <div className="toolbar form-actions">
        {!readOnly && (
          <button type="submit" data-variant="primary" disabled={save.status === 'saving'}>
            {submitLabel}
          </button>
        )}
        {back && (
          <a className="btn" href={back.href}>
            {back.label}
          </a>
        )}
        {href && (
          <a className="btn" href={href} target="_blank" rel="noopener">
            Open on site
          </a>
        )}
        {!readOnly && <SaveStatus state={save.status} savedAt={save.savedAt} />}
        {!save.isNew && (
          <span className="admin-sub">
            {save.version === 0 ? 'Not saved yet' : `Version ${save.version}`}
          </span>
        )}
      </div>
    </form>
  );

  const content = tabs ? (
    <div className="editor-tabs">
      <TabStrip
        tabs={tabs.map((t) => ({
          id: t.id,
          label: t.label,
          icon: t.icon,
          cue: flagged.has(t.id) ? 'has errors' : undefined,
        }))}
        label={tabsLabel}
        value={tab}
        onChange={choose}
        idBase={tabBase}
        param="tab"
      />
      {form}
      {panelTabs.map((t) => {
        const ids = tabIds(tabBase, t.id);
        return (
          <div
            key={t.id}
            role="tabpanel"
            id={ids.panel}
            aria-labelledby={ids.tab}
            tabIndex={0}
            data-editor-tab={t.id}
            hidden={t.id !== tab}
          >
            {opened.has(t.id) && t.panel ? panels?.[t.panel] : null}
          </div>
        );
      })}
    </div>
  ) : (
    form
  );

  return (
    <EditorLanguageProvider>
      <ArabicGapsProvider>{content}</ArabicGapsProvider>
    </EditorLanguageProvider>
  );
}
