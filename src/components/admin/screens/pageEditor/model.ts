import { SECTION_TYPES } from '@schemas/sectionTypes';
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
  /** Releases on: the row's pending change (R3a's DraftMeta), as the list read laid it on. */
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

/** A new section: hidden, at the end, with nothing of its own stored. */
export function newSectionPayload(pageId: string, type: string, rows: readonly SectionRow[]): Row {
  const last = rows.reduce((max, row) => Math.max(max, row.sortOrder), 0);
  return {
    pageId,
    type,
    content: {},
    visible: false,
    sortOrder: last + ORDER_STEP,
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
 * eye, a rename, a move): each write moves the row's version, and a form still holding the
 * old one would answer its next save with "Someone else saved changes".
 *   adopt-row      the form has nothing unsaved and the write answered the whole row: take it;
 *   adopt-version  live mode, the write answered no whole row or the form has unsaved edits:
 *                  take the new version only, and only when it is the very next one
 *                  (useEntitySave's adoptVersion), so a colleague's save in between still
 *                  stops the form with the 409 that protects it;
 *   reload         releases on and nothing unsaved, but no whole row: read the row again
 *                  (its pending change moved too);
 *   none           releases on with unsaved edits: the form keeps them, and its next save
 *                  says the change moved under it ("Reload their version").
 */
export type FormSync = 'adopt-row' | 'adopt-version' | 'reload' | 'none';

export function formSyncAfterWrite(state: {
  mode: 'live' | 'draft';
  /** Unsaved edits, or a save on its way. */
  dirty: boolean;
  /** The write answered the whole row (a PATCH does; a reorder answers a count). */
  fullRow: boolean;
}): FormSync {
  if (!state.dirty) {
    if (state.fullRow) return 'adopt-row';
    return state.mode === 'live' ? 'adopt-version' : 'reload';
  }
  return state.mode === 'live' ? 'adopt-version' : 'none';
}

/** Whether a list answer, or a row in it, came through the release (releases on). */
export function readsThroughRelease(answer: Row): boolean {
  if ('draftsInvalid' in answer) return true;
  const rows = Array.isArray(answer['rows']) ? (answer['rows'] as Row[]) : [];
  return rows.some((row) => row && typeof row === 'object' && 'draft' in row);
}
