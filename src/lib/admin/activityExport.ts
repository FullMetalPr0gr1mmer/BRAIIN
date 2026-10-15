import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActivityFilters } from '@schemas/audit';
import type { AuthContext } from '@/lib/auth/types';
import { describe, KIND_BADGE, sentence, type ActivityRow } from './auditLabels';
import { applyFilters, personOf, readPeople } from './activity';
import { formatDateTime } from './relTime';

// The activity log as a CSV file (Admin v2 U13, GET /api/admin/audit/export; the route holds
// the lockdown's order). This module reads the rows and writes the records.
//
// What the file holds: when (UTC and the studio's clock), who (the name, from the directory's
// audit door, former members included), their role, the kind, what they did in words, the
// item's type and id, and the names of the fields a save changed. Never `detail`'s values,
// never the hashes, and no titles (U13 decision D5: a title read per entity type per chunk
// would spend the Free plan's 50 subrequests, and the type and id do not change when a title
// does).

/**
 * The most entries one file carries (U13 decision D4). Set by CPU, as the lead export's caps
 * are (src/lib/crm/exportRead.ts): a row costs what `describe` and the CSV writer cost, with
 * nothing decrypted; `node scripts/bench-activity-export.mjs` measures it in workerd and
 * docs/admin-v2/as-built/U13.md records the run.
 */
export const ACTIVITY_EXPORT_CAP = 1000;

/** PostgREST's default row limit: the most one page asks for. */
const PAGE_ROWS = 1000;
/** The most pages one file reads (the lead export's bound, for the same 50 subrequests). */
const MAX_PAGES = 20;

const COLUMNS = 'id,actor_id,actor_role,action,entity_type,entity_id,detail,created_at';

export const ACTIVITY_CSV_HEADER = [
  'when_utc',
  'when_riyadh',
  'who',
  'role',
  'kind',
  'what',
  'item_type',
  'item_id',
  'changed_fields',
] as const;

export interface ActivityRead {
  rows: ActivityRow[];
  /** More entries match than the file carries (or the read could not tell). */
  truncated: boolean;
}

/**
 * Up to `cap` entries matching the filters, newest first, keyset-paged on the id (a new
 * entry is newer than every id already read, so nothing repeats or slips), asking one past
 * the cap to know whether more remain.
 */
export async function readActivityRows(
  sb: SupabaseClient,
  tenantId: string,
  filters: ActivityFilters,
  cap: number = ACTIVITY_EXPORT_CAP,
): Promise<ActivityRead> {
  const want = cap + 1;
  const rows: ActivityRow[] = [];
  let before: number | null = null;
  for (let n = 0; n < MAX_PAGES; n += 1) {
    let query = applyFilters(sb.from('audit_log').select(COLUMNS), tenantId, filters);
    if (before !== null) query = query.lt('id', before);
    const { data, error } = await query
      .order('id', { ascending: false })
      .limit(Math.min(PAGE_ROWS, want - rows.length));
    if (error) throw new Error(`activity export: ${error.code ?? 'no code'}`);
    const got = (Array.isArray(data) ? data : []) as ActivityRow[];
    if (got.length === 0) return { rows, truncated: false };
    rows.push(...got);
    if (rows.length >= want) return { rows: rows.slice(0, cap), truncated: true };
    const last = Number(got[got.length - 1]!.id);
    if (!Number.isSafeInteger(last)) throw new Error('activity export: a row came back without its id');
    before = last;
  }
  return { rows: rows.slice(0, cap), truncated: true };
}

/** The rows as the file's records: names read once for the batch, in chunks of 100. */
export async function toActivityRecords(
  sb: SupabaseClient,
  auth: Pick<AuthContext, 'tenantId'>,
  rows: readonly ActivityRow[],
): Promise<Record<string, unknown>[]> {
  const ids = rows.map((row) => row.actor_id).filter((id): id is string => typeof id === 'string');
  const people = ids.length > 0 ? await readPeople(sb, auth.tenantId, ids) : new Map();
  return rows.map((row) => {
    const description = describe(row);
    const who = personOf(row, people);
    return {
      when_utc: typeof row.created_at === 'string' ? new Date(row.created_at).toISOString() : '',
      when_riyadh: formatDateTime(row.created_at),
      // A member switched off keeps their name, marked; one removed altogether has none.
      who: who.former && who.known ? `${who.name} (former member)` : who.name,
      role: who.roleLabel ?? '',
      kind: KIND_BADGE[description.kind].label,
      what: sentence(description),
      item_type: row.entity_type ?? '',
      item_id: row.entity_id ?? '',
      changed_fields: description.fields.join(', '),
    };
  });
}

/** "activity-2026-10-15.csv", or "activity-2026-10-15-first-1000.csv" for a cut file. */
export function activityFilename(now: Date, rows: number, truncated: boolean): string {
  // The studio's day: the Riyadh date of `now`.
  const day = new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return truncated ? `activity-${day}-first-${rows}.csv` : `activity-${day}.csv`;
}
