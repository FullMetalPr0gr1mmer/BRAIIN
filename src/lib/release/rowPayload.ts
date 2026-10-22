import { riyadhDayOf } from '@schemas/visibility';
import { clipOfColumns } from '@/lib/admin/resources/shared';
import { mediaRowToItem } from '@/lib/admin/resources/portfolio';
import { jsonEqual } from './deepEqual';
import { derivePatch, type DerivedPatch } from './overlay';
import type { RegistryEntry } from './registry';

// A stored row back to the change an editor would have saved (Admin v2 R10; releases.md A3-8,
// §6.2). SERVER ONLY. A restore stages a version's state as pending changes, and a pending
// change is a PAYLOAD (camelCase, as the editor sends it), re-parsed by every consumer with the
// entity's own schema and `toRow` (A3-13): so a row image from the ledger, or a history
// snapshot, is turned back into the payload that writes it, here.
//
// The inverse of `toRow`, per payload key (the entity's `fields`, the same map R2 built `toRow`
// beside):
//   • a key that `pick` copies to one column takes that column's value (most keys);
//   • a clip (`clip` on services and disciplines, `preview` on a case study) is rebuilt from its
//     `preview_*` columns, as the editor's own row reader does (`clipOfColumns`);
//   • page visibility's target is its page or template, and its dates are the Riyadh days of
//     the midnights stored;
//   • a case study's link sets come from the ledger's `portfolio_children` image;
//   • immediate columns (the job-application switch, a password's version) are never part of
//     a change, and neither is a per-item schedule or a first-publish date (the apply's).
// Then the round trip: the payload is parsed and mapped as a publish would (`derivePatch`), and
// every allowlisted column the image holds must come back with the image's value. A column
// another column derives (`body_html`, `reading_minutes`) is recomputed by today's code, so it
// is not compared. Anything else that does not come back (a value today's schema refuses, a
// mode no editor can set) is a refusal naming the columns, never a change that writes
// something the version did not hold.

type Row = Record<string, unknown>;
type Payload = Record<string, unknown>;

/** Columns `toRow` derives from another key's value: recomputed, never compared. */
export const DERIVED_COLUMNS: readonly string[] = ['body_html', 'reading_minutes'];

/**
 * Allowlisted columns no payload key writes (a section's legacy `style`, a password gate's
 * `note`, R2's restore-only entries): a restore leaves them as they are live.
 */
export function restoreOnlyColumns(entry: RegistryEntry): string[] {
  const written = new Set(Object.values(entry.fields).flat());
  return entry.columns.filter((column) => !written.has(column));
}

/** A case study's link sets as the ledger keeps them (`app.portfolio_link_sets`, 0066). */
export interface LinkSetsImage {
  service_ids?: unknown;
  media?: unknown;
}

/** The ledger's link sets → the payload's child keys (`serviceIds`, `media`). */
export function childrenPayload(image: LinkSetsImage | null | undefined): Payload {
  if (!image) return {};
  const out: Payload = {};
  if (Array.isArray(image.service_ids)) out['serviceIds'] = [...image.service_ids];
  if (Array.isArray(image.media)) {
    out['media'] = (image.media as Row[]).map((row) => mediaRowToItem(row));
  }
  return out;
}

/** Whether every column of a key is outside what a release writes. */
function outsideAllowlist(entry: RegistryEntry, columns: readonly string[]): boolean {
  return columns.every(
    (column) => !entry.columns.includes(column) || entry.immediateColumns.includes(column),
  );
}

/** The payload that writes `row` (a full image), by the entity's own key map. */
export function rowToPayload(
  entry: RegistryEntry,
  row: Readonly<Row>,
  children?: LinkSetsImage | null,
): Payload {
  const out: Payload = {};
  if (entry.kind === 'pageVisibility') {
    if (typeof row['page_id'] === 'string') out['target'] = { pageId: row['page_id'] };
    else if (typeof row['template'] === 'string') out['target'] = { template: row['template'] };
    out['mode'] = row['mode'];
    out['redirectPageId'] = row['redirect_page_id'] ?? null;
    out['hideFrom'] = typeof row['hide_from'] === 'string' ? riyadhDayOf(row['hide_from']) : null;
    out['showOn'] = typeof row['show_on'] === 'string' ? riyadhDayOf(row['show_on']) : null;
    return out;
  }
  for (const [key, columns] of Object.entries(entry.fields)) {
    if (columns.length === 0 || outsideAllowlist(entry, columns)) continue;
    if (columns.includes('preview_video_path')) {
      // A clip: rebuilt from its columns (a case study's has a Stream uid column too).
      if (!columns.some((column) => column in row)) continue;
      out[key] = clipOfColumns(
        columns.includes('preview_video_uid') ? row['preview_video_uid'] : null,
        row['preview_video_path'],
        row['preview_start_s'],
        row['preview_end_s'],
      );
      continue;
    }
    const column = columns[0]!;
    if (column in row) out[key] = row[column];
  }
  Object.assign(out, childrenPayload(children));
  return out;
}

/**
 * The columns that name an entity-SEO row's or a visibility setting's target: written once,
 * on create (`target()`), and never part of an edit, so an edit's round trip skips them.
 */
function targetColumns(entry: RegistryEntry): string[] {
  if (entry.kind === 'entitySeo') return ['entity_type', 'entity_id'];
  if (entry.kind === 'pageVisibility') return ['page_id', 'template'];
  return [];
}

/** Why a stored row cannot be staged as it was. */
export interface RestoreMismatch {
  /** `unreadable`: today's schema or rules refuse it; `columns`: some do not come back. */
  reason: 'unreadable' | 'columns';
  columns: string[];
}

export type RestoredPatch =
  { ok: true; payload: Payload; derived: DerivedPatch } | ({ ok: false } & RestoreMismatch);

/**
 * The change that writes `row` back, checked by the round trip (above). `op` is the change's:
 * `create` (the row is gone, it comes back with its own id) or `update`.
 */
export function restorePatch(
  entry: RegistryEntry,
  op: 'create' | 'update',
  row: Readonly<Row>,
  children?: LinkSetsImage | null,
): RestoredPatch {
  const payload = rowToPayload(entry, row, children);
  let derived: DerivedPatch;
  try {
    derived = derivePatch(entry, op, payload);
  } catch {
    return { ok: false, reason: 'unreadable', columns: [] };
  }
  const skip = new Set([
    ...DERIVED_COLUMNS,
    ...restoreOnlyColumns(entry),
    ...entry.immediateColumns,
    ...(op === 'update' ? targetColumns(entry) : []),
  ]);
  const targets = targetColumns(entry);
  const lost = entry.columns.filter((column) => {
    if (skip.has(column) || !(column in row)) return false;
    if (column in derived.patch) return !jsonEqual(derived.patch[column], row[column]);
    // A create writes one target column; the other is null in the image (one or the other).
    return !(targets.includes(column) && row[column] === null);
  });
  if (lost.length > 0) return { ok: false, reason: 'columns', columns: lost };
  return { ok: true, payload, derived };
}
