import type { LeadExportQuery } from '@schemas/crm';

// How the lead CSV export pages its read (src/pages/api/admin/leads/export.ts builds each
// page's query, so the service-role lead read stays in the route, where
// tests/lib/leadGrants.spec.ts looks for it).
//
// The filters are the list's (public.leads_list, 0036), so a link from the list exports what
// the list shows: spam only when asked for (a legacy `?status=spam` link asks too), `from`
// inclusive and `to` exclusive.
//
// The read is keyset-paged on (created_at, id), newest first: each page asks for the leads
// after the last one it has. Offset paging over a moving table repeats or skips a row when a
// lead arrives mid-export; a keyset cannot (a new lead is newer than every key already read).
// Whether more remain is decided by asking for one row past the cap, never by a short page: a
// page comes back short when PostgREST's row limit is lower than the page asked for, so the
// read carries on until a page comes back EMPTY or the cap is passed.

/** The most leads one export carries; larger pulls are `export-backup`. */
export const MAX_EXPORT_ROWS = 5000;

/** PostgREST's default row limit: the most one page asks for. */
export const PAGE_ROWS = 1000;

/**
 * The most pages one export reads. A Worker on the Free plan has 50 subrequests a request,
 * and a server whose row limit is far below PAGE_ROWS would otherwise page until it ran out
 * of them. Reaching it marks the export truncated: whether more remain is not known.
 */
export const MAX_PAGES = 20;

/** Where the next page starts: strictly after this lead, newest first. */
export interface ExportCursor {
  at: string;
  id: string;
}

/** One page: at most `limit` leads after `after` (from the start when null). */
export type ExportPage = (
  limit: number,
  after: ExportCursor | null,
) => Promise<Record<string, unknown>[]>;

export interface ExportRead {
  rows: Record<string, unknown>[];
  /** More leads match than the export carries (or it could not tell). */
  truncated: boolean;
}

const KEY_TIME = /^\d{4}-\d{2}-\d{2}[T ][0-9:.]+(?:Z|[+-]\d{2}(?::?\d{2})?)$/;
const KEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A row's key, checked: it goes back into the next page's filter. */
function keyOf(row: Record<string, unknown>): ExportCursor {
  const at = row['created_at'];
  const id = row['id'];
  if (typeof at !== 'string' || !KEY_TIME.test(at) || typeof id !== 'string' || !KEY_ID.test(id)) {
    throw new Error('export leads: a row came back without its key');
  }
  return { at, id };
}

/**
 * The PostgREST filter for "after this key" under `created_at desc, id asc`: an older lead,
 * or one at the same instant with a later id. The time is quoted because it holds PostgREST's
 * reserved characters; both values were checked by keyOf.
 */
export function afterFilter(after: ExportCursor): string {
  return `created_at.lt."${after.at}",and(created_at.eq."${after.at}",id.gt.${after.id})`;
}

/** Is the export asking for spam? Only when it says so, as on the list. */
export function exportsSpam(input: LeadExportQuery): boolean {
  if (input.spam !== undefined) return input.spam === 'true';
  return input.status === 'spam';
}

/** Up to `cap` leads, page by page, and whether more match. */
export async function readPaged(page: ExportPage, cap: number): Promise<ExportRead> {
  const want = cap + 1;
  const rows: Record<string, unknown>[] = [];
  let after: ExportCursor | null = null;
  for (let n = 0; n < MAX_PAGES; n += 1) {
    const got = await page(Math.min(PAGE_ROWS, want - rows.length), after);
    if (got.length === 0) return { rows, truncated: false };
    rows.push(...got);
    if (rows.length >= want) return { rows: rows.slice(0, cap), truncated: true };
    after = keyOf(got[got.length - 1]!);
  }
  return { rows: rows.slice(0, cap), truncated: true };
}
