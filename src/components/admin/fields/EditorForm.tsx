import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import ErrorSummary, { type FieldError } from '@/components/admin/kit/ErrorSummary';
import Note from '@/components/admin/kit/Note';
import SaveStatus from '@/components/admin/kit/SaveStatus';
import { TabStrip, tabIds, writeTabParam } from '@/components/admin/kit/Tabs';
import { tabOfElement, tabsWithErrors } from '@/lib/admin/editorTabs';
import { badInputErrors, type MappedErrors } from '@/lib/admin/fieldErrors';
import type { EntitySave } from '@/lib/admin/useEntitySave';
import { useSaveShortcut } from '@/lib/admin/useEntitySave';
import type {
  EditorLanguage,
  EditorPanel,
  EditorTabDef,
  FieldDef,
  FieldGroup,
} from '@/lib/admin/uiSchema';
import { Field, FieldsReadOnly } from '../FormField';
import { useRevealListener } from './reveal';
import DraftNotice from './DraftNotice';
import VisibilityField, { isItemSchedule, isLifecycleStatus } from './VisibilityField';
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
//     card (with `heading`, U11, the card's header band: the prototype's `card(title, sub)`)
//     or, given `groups` (U9), in the groups' titled cards;
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
// Admin v2 R12, release mode (`save.mode === 'draft'`, which only the server's answer sets, so
// with releases off nothing here renders and the form is byte for byte what it was): the
// pending change at the head of the form (DraftNotice: its badge and words, Discard changes or
// Undo removal, a conflict's Keep mine / Use the live version / Compare); the per-item Schedule
// field gone and the status select a "Visible on the site" switch (VisibilityField: a release
// is scheduled, never one item); the form saving by itself when focus leaves it and on a tab
// switch (`save.flush`, P-5); a staged removal or a scheduled change read only; "Saved as an
// unpublished change at 14:05"; "Live version N" or "Not live yet".
// `publicHref` adds "Open on site" to the action bar when it gives an address, read from the
// record as saved (`save.saved`), never from unsaved edits: choosing Published, or editing a
// published post's slug, links nowhere until it is saved. Field groups
// (U9a) compose inside a field tab: a group renders in its tab's card, never across two tabs.
// The tab API is frozen in docs/admin-v2/as-built/U8.md for U5 and U6.
// Admin v2 E1, the page editor, adds three props, each off unless asked for (without them the
// output is byte for byte what it was): `hidden` (fields the save carries but the form never
// draws: a section's `type`), `builtIn` (a field's built-in value, by name: the section
// content field's prefill, F5b) and `languageBar: 'page'` (the screen draws the language
// switch and "Arabic missing: N" for every column, and its providers wrap this form).

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
   * Admin v2 U9: the cards the fields sit in (the prototype's settings screens: titled cards
   * in two columns, an Advanced card closed). Without it the fields are one card, as before.
   */
  groups?: readonly FieldGroup[] | undefined;
  /** Admin v2 U9: what a group shows before its fields, by group id (the logo tiles). */
  slots?: Readonly<Record<string, ReactNode>> | undefined;
  /** Admin v2 U8b: the editor's tabs (the role's own: see editorTabs.ts visibleTabs). */
  tabs?: readonly EditorTabDef[] | undefined;
  /** The tab list's name ("Post editor"). */
  tabsLabel?: string | undefined;
  /**
   * What each panel tab shows (`panel: 'seo'`: the shared SEO editor, or a note; U5: a
   * service's `case` study and its `leads`).
   */
  panels?: Partial<Record<EditorPanel, ReactNode>> | undefined;
  /**
   * Admin v2 U5/U6: what a FIELD tab shows after its fields, by tab id, inside the form (a
   * project's testimonial card, the publish requirements): no form of its own, and nothing it
   * holds is sent with the save. Without it a tab is its fields, as before.
   */
  tabExtras?: Readonly<Partial<Record<string, ReactNode>>> | undefined;
  /** The tab to open on: the server's reading of `?tab=` (editorTabs.ts firstTab). */
  initialTab?: string | null | undefined;
  /** Admin v2 U8b: the record can be read, not saved, by this role. */
  readOnly?: boolean | undefined;
  /** What a read-only role is told, above the fields. */
  readOnlyNote?: ReactNode;
  /** The record's public address ("Open on site"), or null; given the saved values. */
  publicHref?: ((values: Readonly<Record<string, unknown>>) => string | null) | undefined;
  /**
   * Admin v2 U5/U6: the language the form opens in, over the browser's remembered choice (an
   * Add modal that asks for a name in both languages opens in Both). Unset, as before: English
   * first, then the remembered choice.
   */
  initialLanguage?: EditorLanguage | undefined;
  /**
   * Admin v2 U5: the prefix of the fields' element ids (`<prefix>-<name>`), `f` by default. A
   * second form on the same page (a service's case study, beside the service's own form,
   * which stays mounted while hidden) takes another, so no id repeats: a label would
   * otherwise name the hidden form's input, and an error link would land there. The save's
   * errors (keyed `f-…` by fieldErrors.ts) are moved onto it. Not for a tabbed form: the
   * tabs find a field by the `f-` ids (editorTabs.ts).
   */
  idPrefix?: string | undefined;
  /**
   * Admin v2 U11: the fields' card's header (the prototype's `.card__h`: a title, an h2 under
   * the page's h1, and a line under it), for a form with no tabs that is one named card.
   */
  heading?: { title: string; sub?: string | undefined } | undefined;
  /** Admin v2 R12: the record in words for the discard confirm ("service"). */
  noun?: string | undefined;
  /**
   * Admin v2 E1: fields the save carries (loaded and sent) but the form never draws: a page
   * section's `type`, which its content field reads to know its own fields.
   */
  hidden?: readonly string[] | undefined;
  /**
   * Admin v2 E1: a field's built-in value, by its name: what a section shows with nothing
   * stored (F5b's `builtIn` prop of the section content field, wired by the page editor).
   */
  builtIn?: Readonly<Record<string, unknown>> | undefined;
  /**
   * Admin v2 E1: whose language bar this is. `own` (the default): the form draws English /
   * العربية / Both and "Arabic missing: N" above its fields and keeps the language to
   * itself. `page`: the screen holds them (the page editor's bar, for every column), so the
   * form draws neither and reads the screen's language and gap list.
   */
  languageBar?: 'own' | 'page' | undefined;
}

/** The save's errors (fieldErrors.ts keys them `f-…`) under another id prefix. */
export function withIdPrefix(
  errors: { byId: Readonly<Record<string, string>>; summary: readonly FieldError[] },
  prefix: string,
): { byId: Readonly<Record<string, string>>; summary: readonly FieldError[] } {
  if (prefix === 'f') return errors;
  const move = (id: string) => (id === 'f' || id.startsWith('f-') ? `${prefix}${id.slice(1)}` : id);
  return {
    byId: Object.fromEntries(Object.entries(errors.byId).map(([id, msg]) => [move(id), msg])),
    summary: errors.summary.map((item) => (item.id ? { ...item, id: move(item.id) } : item)),
  };
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

/** The groups' cards, in two columns where a group names one; ungrouped fields after. */
function GroupedFields({
  groups,
  slots,
  fields,
  renderField,
}: {
  groups: readonly FieldGroup[];
  slots: Readonly<Record<string, ReactNode>> | undefined;
  fields: readonly FieldDef[];
  renderField: (field: FieldDef) => ReactNode;
}) {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const grouped = new Set(groups.flatMap((g) => g.fields));
  const card = (group: FieldGroup) => {
    const body = (
      <>
        {group.sub && <p className="admin-sub editor__group-sub">{group.sub}</p>}
        {slots?.[group.id]}
        {group.fields.flatMap((name) => {
          const field = byName.get(name);
          return field ? [renderField(field)] : [];
        })}
      </>
    );
    const headingId = `g-${group.id}`;
    // A closed card is a <details>: an error inside it is shown by opening it first
    // (fields/reveal.ts), so the summary links of the ErrorSummary still land.
    return group.collapsible ? (
      <details key={group.id} className="card editor__group" data-group={group.id}>
        <summary className="card-title">{group.title}</summary>
        {body}
      </details>
    ) : (
      <section
        key={group.id}
        className="card editor__group"
        data-group={group.id}
        aria-labelledby={headingId}
      >
        <h2 className="card-title" id={headingId}>
          {group.title}
        </h2>
        {body}
      </section>
    );
  };
  const left = groups.filter((g) => g.column === 'left');
  const right = groups.filter((g) => g.column === 'right');
  const full = groups.filter((g) => g.column !== 'left' && g.column !== 'right');
  const rest = fields.filter((f) => !grouped.has(f.name));
  return (
    <>
      {(left.length > 0 || right.length > 0) && (
        <div className="grid grid--2 editor__cols">
          <div className="editor__col">{left.map(card)}</div>
          <div className="editor__col">{right.map(card)}</div>
        </div>
      )}
      {full.map(card)}
      {rest.length > 0 && <div className="card">{rest.map(renderField)}</div>}
    </>
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
  groups,
  slots,
  tabs,
  tabsLabel = 'Editor sections',
  panels,
  tabExtras,
  initialTab,
  readOnly: readOnlyProp = false,
  readOnlyNote,
  publicHref,
  initialLanguage,
  idPrefix = 'f',
  heading,
  noun = 'item',
  hidden,
  builtIn,
  languageBar = 'own',
}: EditorFormProps) {
  // R12: the server put this record in release mode (its answer carried `draft`).
  const draftMode = save.mode === 'draft';
  // A staged removal, or a change a scheduled release holds, is read only until undone.
  const readOnly =
    readOnlyProp || (draftMode && (save.pendingRemoval === true || Boolean(save.draft?.releaseId)));
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
    // R12: a section switch saves a pending change (P-5); a no-op in live mode.
    save.flush?.();
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
            'input[type="number"], input[type="datetime-local"], input[type="date"]',
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
  // A browser-unreadable box's error is keyed by its own (already prefixed) id; the server's
  // are `f-…` and move onto the prefix.
  const errors = local ?? withIdPrefix(save.errors, idPrefix);
  // R12: in release mode the per-item schedule goes (a release is scheduled, never one item).
  // E1: a hidden field is carried by the save, never drawn.
  const drawn =
    hidden && hidden.length > 0 ? fields.filter((f) => !hidden.includes(f.name)) : fields;
  const shownFields = draftMode ? drawn.filter((f) => !isItemSchedule(f)) : drawn;
  const renderField = (field: FieldDef) =>
    draftMode && isLifecycleStatus(field) ? (
      <VisibilityField
        key={field.name}
        field={field}
        value={save.values[field.name]}
        onChange={save.set}
        idPrefix={idPrefix}
        errors={errors.byId}
      />
    ) : (
      <Field
        key={field.name}
        field={field}
        value={save.values[field.name]}
        values={save.values}
        onChange={save.set}
        errors={errors.byId}
        canAdvanced={canAdvanced}
        {...(idPrefix === 'f' ? {} : { idPrefix })}
        {...(builtIn && field.name in builtIn ? { builtIn: builtIn[field.name] } : {})}
      />
    );
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!readOnly) submit();
  };

  // The fields' cards: the groups' (U9) when there are any, else one card as before, with
  // `head`'s header band (U11) when the form is that one named card (groups title their own).
  const fieldsBlock = (
    shown: readonly FieldDef[],
    cards: readonly FieldGroup[],
    head?: EditorFormProps['heading'],
  ) =>
    cards.length > 0 ? (
      <GroupedFields groups={cards} slots={slots} fields={shown} renderField={renderField} />
    ) : (
      <div className="card">
        {head && (
          <div className="card__h">
            <div>
              <h2 className="card__t">{head.title}</h2>
              {head.sub && <p className="card__sub">{head.sub}</p>}
            </div>
          </div>
        )}
        {shown.map(renderField)}
      </div>
    );
  // Groups compose inside a field tab (U8.md): a group renders in the tab that holds all of
  // its fields; one that would span two tabs is drawn in neither, its fields plain in theirs.
  const inTab = (own: ReadonlySet<string>) =>
    (groups ?? []).filter((g) => g.fields.every((name) => own.has(name)));

  const fieldTabs = tabs?.filter((t) => !t.panel) ?? [];
  const panelTabs = tabs?.filter((t) => t.panel) ?? [];
  const current = tabs?.find((t) => t.id === tab);
  const flagged = tabs ? tabsWithErrors(errors.byId, tabs, fields) : new Set<string>();

  let fieldBlock: ReactNode = tabs
    ? fieldTabs.map((t) => {
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
            {fieldsBlock(
              shownFields.filter((f) => own.has(f.name)),
              inTab(own),
            )}
            {tabExtras?.[t.id]}
          </div>
        );
      })
    : fieldsBlock(shownFields, groups ?? [], heading);
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
      // R12: focus leaving a control saves a pending change (P-5), after the change event
      // has landed in the form's state. Only in release mode: live mode saves on Save alone.
      onBlur={draftMode ? () => window.setTimeout(() => save.flush?.(), 0) : undefined}
    >
      <ErrorSummary errors={errors.summary} />
      {save.message && !save.releasesOff && (
        <p className="msg" data-kind="error" role="alert">
          {save.message}
        </p>
      )}
      {save.releasesOff && (
        // R12: releases were switched off under the form. Nothing was saved; a reload reads
        // the record live and the editor saves live from then on.
        <div className="msg editor__conflict" data-kind="error" role="alert">
          <span>{save.message}</span>
          <button type="button" onClick={() => void save.reloadTheirs()}>
            Reload
          </button>
        </div>
      )}
      {save.conflict && (
        <div className="msg editor__conflict" data-kind="error" role="alert">
          <span>Someone else saved changes while you were editing.</span>
          <button type="button" onClick={() => void save.reloadTheirs()}>
            Reload their version
          </button>
        </div>
      )}
      {draftMode && <DraftNotice save={save} fields={fields} noun={noun} backHref={back?.href} />}
      {bilingual && languageBar === 'own' && (
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
            {save.gone ? 'Save again' : submitLabel}
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
        {!readOnly && (
          <SaveStatus
            state={save.status}
            savedAt={save.savedAt}
            {...(draftMode ? { staged: true } : {})}
          />
        )}
        {!save.isNew && (
          <span className="admin-sub">
            {draftMode
              ? save.version === 0
                ? 'Not live yet'
                : `Live version ${save.version}`
              : save.version === 0
                ? 'Not saved yet'
                : `Version ${save.version}`}
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

  // E1: the screen holds the language and the gaps (its own providers, around this form).
  if (languageBar === 'page') return content;
  return (
    <EditorLanguageProvider initial={initialLanguage}>
      <ArabicGapsProvider>{content}</ArabicGapsProvider>
    </EditorLanguageProvider>
  );
}
