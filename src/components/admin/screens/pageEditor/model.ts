import { SECTION_TYPES } from '@schemas/sectionTypes';
import { readDraft } from '@/lib/admin/entitySave';
import { stagedBody } from '@/lib/admin/releaseEvents';
import type { SectionContentState } from '@/lib/admin/formPayload';
import type { FieldDef } from '@/lib/admin/uiSchema';
import { PLACEHOLDER_FIELD } from '@/lib/admin/ui/fields';
import { pagesUi } from '@/lib/admin/ui/pages';
import { ORDER_STEP } from '../collection/reorder';
import { lookKey } from './library';
import type { BuiltInLooks } from './types';

// The page editor's rules (Admin v2 E1), pure so they are unit-tested without a browser
// (tests/lib/pageEditorModel.spec.ts): what a section row is, the forms' fields, which
// built-in copy a section shows, what a new section is, and how the open form follows a
// write the sections column made to the same row.

type Row = Record<string, unknown>;

/** One section as the sections column lists it (GET /api/admin/sections?page_id=…). */
export interface SectionRow {
  id: string;
  type: string;
  label: string | null;
  visible: boolean;
  sortOrder: number;
  version: number;
  placeholder: boolean;
  /**
   * Releases on: the row's pending change (R3a's DraftMeta), as the list read laid it on. A row
   * with nothing pending carries no `draft` key at all, exactly like a row read live, so the
   * key never says which mode the screen is in (readsThroughRelease does).
   */
  draft?: unknown;
  pendingRemoval?: boolean;
}

/** A list answer's row as the column keeps it; null for a row it cannot read. */
export function sectionRowOf(raw: Row): SectionRow | null {
  if (typeof raw['id'] !== 'string' || typeof raw['type'] !== 'string') return null;
  const row: SectionRow = {
    id: raw['id'],
    type: raw['type'],
    label: typeof raw['label'] === 'string' && raw['label'].trim() ? raw['label'] : null,
    visible: raw['visible'] === true,
    sortOrder: typeof raw['sort_order'] === 'number' ? raw['sort_order'] : 0,
    version: typeof raw['version'] === 'number' ? raw['version'] : 1,
    placeholder: raw['is_placeholder'] === true,
  };
  if ('draft' in raw) row.draft = raw['draft'];
  if (raw['pendingRemoval'] === true) row.pendingRemoval = true;
  return row;
}

/** The column's order: the stored sort order, then the id (a stable tie-break). */
export function inOrder(rows: readonly SectionRow[]): SectionRow[] {
  return [...rows].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

/** Whether a section is the first of its type on the page (hidden ones count: F6). */
export function isFirstOfType(rows: readonly SectionRow[], id: string): boolean {
  const ordered = inOrder(rows);
  const at = ordered.findIndex((row) => row.id === id);
  if (at === -1) return true;
  const type = ordered[at]!.type;
  return !ordered.slice(0, at).some((row) => row.type === type);
}

// ---- The forms -------------------------------------------------------------------------

/** A section's type: carried by the section form (its content field reads it), never drawn. */
export const SECTION_TYPE_FIELD: FieldDef = {
  name: 'type',
  label: 'Section type',
  kind: 'select',
  options: SECTION_TYPES.map((type) => ({ value: type, label: type })),
};

/** A section's words, typed by its type (SECTION_UI), prefilled with the built-in copy. */
export const SECTION_CONTENT_FIELD: FieldDef = {
  name: 'content',
  label: 'Content',
  kind: 'sectionContent',
  typeField: 'type',
};

/** The section form's fields: the type (hidden), the content, and the sample flag if any. */
export function sectionFormFields(placeholder: boolean): FieldDef[] {
  return placeholder
    ? [SECTION_TYPE_FIELD, SECTION_CONTENT_FIELD, PLACEHOLDER_FIELD]
    : [SECTION_TYPE_FIELD, SECTION_CONTENT_FIELD];
}

/**
 * The page details: the page's own title, status and schedule, the legacy page form's fields
 * less the address (a routed page's slug is fixed: 0057's pages_route_slug_fixed).
 */
export const PAGE_FIELDS: readonly FieldDef[] = pagesUi.fields.filter((f) => f.name !== 'slug');

// ---- The built-in copy -----------------------------------------------------------------

/** The variant a section's form holds now (the look of `social` and `statistics`). */
export function variantOf(content: unknown): unknown {
  const state = content as Partial<SectionContentState> | null | undefined;
  if (!state || typeof state !== 'object') return undefined;
  if (state.json !== null && state.json !== undefined) return undefined;
  const value = state.values?.['variant'];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The built-in copy a section shows now, for its content field's prefill: its type's look on
 * this page, at its place, with the variant its form holds. Undefined when the server sent
 * none for the type (a type with no copy of its own words).
 */
export function builtInFor(
  builtIns: BuiltInLooks,
  section: { type: string; page: string; firstOfType: boolean; content: unknown },
): Row | undefined {
  const looks = builtIns[section.type];
  if (!looks) return undefined;
  const look = lookKey(section.type, {
    page: section.page,
    variant: variantOf(section.content),
    firstOfType: section.firstOfType,
  });
  const copy = looks[look];
  return copy && Object.keys(copy).length > 0 ? { ...copy } : undefined;
}

// ---- Adding, moving -------------------------------------------------------------------

/**
 * The largest number a section write accepts: SORT_ORDER_MAX in @schemas/admin, restated so
 * the editor's chunk does not load the server's schemas (as U5 + U6's services model does;
 * tests/lib/pageEditorModel.spec.ts holds the two equal).
 */
export const SORT_ORDER_MAX = 10_000;

/**
 * A new section: hidden, at the end, with nothing of its own stored. Its number is one step
 * past the last, held to the route's bound (SORT_ORDER_MAX): a page whose last section already
 * stands at the bound gets the bound too, and the id breaks the tie, so the add is never
 * refused for its number.
 */
export function newSectionPayload(pageId: string, type: string, rows: readonly SectionRow[]): Row {
  const last = rows.reduce((max, row) => Math.max(max, row.sortOrder), 0);
  return {
    pageId,
    type,
    content: {},
    visible: false,
    sortOrder: Math.min(last + ORDER_STEP, SORT_ORDER_MAX),
    isPlaceholder: false,
  };
}

/** The section to open after one is removed: the one after it, else the one before. */
export function neighbourAfterRemoval(rows: readonly SectionRow[], id: string): string | null {
  const ordered = inOrder(rows);
  const at = ordered.findIndex((row) => row.id === id);
  if (at === -1) return ordered[0]?.id ?? null;
  return ordered[at + 1]?.id ?? ordered[at - 1]?.id ?? null;
}

// ---- The open form and the column's writes ---------------------------------------------

/**
 * How the open section's form follows a write the sections column made to the SAME row (its
 * eye, a rename, a move). None of those columns is a field of the form, but each write moves
 * the row's version (releases off) or its pending change's (releases on), and a form still
 * holding the old one would answer its own next save with a conflict:
 *   adopt-version  releases off: take the new version only, and only when it is the very
 *                  next one (useEntitySave's adoptVersion), so a colleague's save in between
 *                  still stops the form with the 409 that protects it;
 *   rebase         releases on, and the column wrote on the pending change the form holds (the
 *                  same one, or none on both sides): read the row again and keep what was typed
 *                  since the last save over it, once a save on its way has landed (R12's
 *                  `rebased` step);
 *   none           releases on, but the form holds another state of the change (someone's save
 *                  in between): it keeps its edits, and its next save says the change moved
 *                  under it ("Reload their version").
 */
export type FormSync = 'adopt-version' | 'rebase' | 'none';

export function formSyncAfterWrite(state: {
  mode: 'live' | 'draft';
  /** The pending change the form holds, as `id:version`, or '' for none. */
  formDraft: string;
  /** The pending change the column's write named, the same way. */
  wroteOn: string;
}): FormSync {
  if (state.mode === 'live') return 'adopt-version';
  return state.formDraft === state.wroteOn ? 'rebase' : 'none';
}

/** A pending change as formSyncAfterWrite compares it: `id:version`, or '' for none. */
export function draftStamp(draft: { id: string; version: number } | null | undefined): string {
  return draft ? `${draft.id}:${draft.version}` : '';
}

/**
 * The pending change a write from the column names beside its values: releases on and the row
 * has one, its id and version; otherwise nothing. The SCREEN's mode decides it (its list
 * answer, releaseEvents.ts readsThroughRelease), never the row: a row with nothing pending has
 * no `draft` key with releases on too.
 */
export function columnDraftRef(row: SectionRow, release: boolean): Row {
  if (!release) return {};
  const draft = readDraft(row as unknown as Row);
  return draft ? { draftId: draft.id, draftVersion: draft.version } : {};
}

/**
 * Whether a column PATCH carries R12's "made in release mode" marker (`staged: true`, through
 * releaseEvents.ts stagedBody): releases on and nothing pending to name. With a pending change
 * the write names it instead (columnDraftRef), which the live route refuses just the same once
 * releases are off (409 `releases-off`). Releases off: never, the request main sends.
 */
export function columnMarks(row: SectionRow, release: boolean): boolean {
  return release && !readDraft(row as unknown as Row);
}

/**
 * Everything a write from the column sends beside its values: the pending change it names, or
 * R12's marker, or (releases off) nothing.
 */
export function columnWriteRef(row: SectionRow, release: boolean): Row {
  return stagedBody(columnDraftRef(row, release), columnMarks(row, release));
}

/**
 * The eye's PATCH values: the other visibility, the version read, and the pending change it
 * names. The editor sends it through stagedBody(…, columnMarks(…)), which adds the marker.
 */
export function toggleBody(row: SectionRow, release: boolean): Row {
  return { visible: !row.visible, version: row.version, ...columnDraftRef(row, release) };
}

/** Rename's PATCH values (null puts back the kind's name), sent as the eye's are. */
export function renameBody(row: SectionRow, label: string | null, release: boolean): Row {
  return { label, version: row.version, ...columnDraftRef(row, release) };
}

/** The pending change a write from the column names, as formSyncAfterWrite compares it. */
export function columnWroteOn(row: SectionRow): string {
  return draftStamp(readDraft(row as unknown as Row));
}

// ---- The live preview's save signal (Admin v2 E2) ---------------------------------------

/** A row's version and its pending change's: a write to it moves one or the other. */
export function rowStamp(row: { version: number | unknown; draft?: unknown }): string {
  return `${String(row.version ?? '')}:${readDraft(row as unknown as Row)?.version ?? ''}`;
}

/**
 * The editor's writes, and which of them reload the live preview (E2): each one a visitor can
 * see. A rename changes only the admin's name for a section, and Add section adds a hidden one,
 * so neither reloads it. Every write the screen makes reports itself here through `wrote(kind)`
 * (PageEditor.tsx; tests/lib/pagePreview.spec.ts reads the call sites from the source).
 */
export const PREVIEW_RELOADS = {
  /** The open section's form saved (Save changes, or an autosave in release mode). */
  field: true,
  /** The page details' form saved. */
  pageDetails: true,
  /** The eye: a section shown or hidden. */
  eye: true,
  /** The order changed. */
  move: true,
  /** A section added (hidden). */
  add: false,
  /** A section renamed (the admin's name only). */
  rename: false,
  /** A section removed. */
  remove: true,
  /** A History restore. */
  restore: true,
} as const satisfies Readonly<Record<string, boolean>>;

export type EditorWrite = keyof typeof PREVIEW_RELOADS;

/** Whether a write of this kind reloads the live preview. */
export function reloadsPreview(kind: EditorWrite): boolean {
  return PREVIEW_RELOADS[kind];
}

/**
 * Whether a row a form read or saved is a save (E2: the preview then reloads): its version or
 * its pending change moved since the list held it. A read of the version the list holds (the
 * form's first load, a rebase after a column write) is not, and neither is a row the list does
 * not hold yet.
 */
export function rowMoved(before: SectionRow | undefined, after: SectionRow): boolean {
  if (!before) return false;
  return rowStamp(before) !== rowStamp({ ...before, ...after });
}

/** The same rule for the page's own row (the page details): `null` until the first read. */
export function pageMoved(before: string | null, row: Row): boolean {
  return before !== null && before !== rowStamp(row as { version: unknown; draft?: unknown });
}
