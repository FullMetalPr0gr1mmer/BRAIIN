import { DEFAULT_TIME_ZONE } from '@schemas/timeZones';
import { zoneOffsetMs } from '@/lib/time/zone';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActivityFilters } from '@schemas/audit';
import type { AuthContext } from '@/lib/auth/types';
import { describe, KIND_BADGE, sentence, type ActivityRow } from './auditLabels';
import { applyFilters, personOf, readPeople } from './activity';

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
 * are (src/lib/crm/exportRead.ts): a row costs what parsing it, `describe`, the name and the
 * CSV writer cost, with nothing decrypted. `node scripts/bench-activity-export.mjs` measures
 * it in workerd: 5 to 6 µs a row (it was 23 before the Riyadh time stopped going through
 * Intl, riyadhDateTime below), so a full file's rows take about 6 ms of the Free plan's 10,
 * the margin the lead export keeps for the rest of the request (the session, the two audit
 * rows, the reads' answers), which was not measured. docs/admin-v2/as-built/U13.md records
 * the run. On Workers Paid the cap could rise toward the 20 pages MAX_PAGES allows.
 */
export const ACTIVITY_EXPORT_CAP = 1000;

/** PostgREST's default row limit: the most one page asks for. */
const PAGE_ROWS = 1000;
/** The most pages one file reads (the lead export's bound, for the same 50 subrequests). */
const MAX_PAGES = 20;

/**
 * The keys of `detail` the file's words are made from (auditLabels.ts `describe`): the
 * status a save moved to and from, entity SEO's target, a menu visibility, a release's
 * number, the changed fields' names. Read one by one, never the whole jsonb: a detail can be
 * large (a release lists every item it applied, a bulk change its counts), and 1,000 of them
 * would be parsed for nothing on the Free plan's 10 ms (U13 review).
 */
const DETAIL_KEYS = {
  d_status: 'detail->>status',
  d_previous: 'detail->>previousStatus',
  d_target: 'detail->>target',
  d_nav: 'detail->navVisible',
  d_number: 'detail->number',
  d_version: 'detail->version',
  d_fields: 'detail->fields',
} as const;
const DETAIL_NAMES: Readonly<Record<keyof typeof DETAIL_KEYS, string>> = {
  d_status: 'status',
  d_previous: 'previousStatus',
  d_target: 'target',
  d_nav: 'navVisible',
  d_number: 'number',
  d_version: 'version',
  d_fields: 'fields',
};

export const EXPORT_COLUMNS = [
  'id,actor_id,actor_role,action,entity_type,entity_id,created_at',
  ...Object.entries(DETAIL_KEYS).map(([alias, path]) => `${alias}:${path}`),
].join(',');

/** A row as read for the file, its few detail keys put back into a small `detail`. */
function withDetail(row: Record<string, unknown>): ActivityRow {
  const detail: Record<string, unknown> = {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (Object.hasOwn(DETAIL_NAMES, key)) {
      if (value !== null && value !== undefined) {
        detail[DETAIL_NAMES[key as keyof typeof DETAIL_KEYS]] = value;
      }
    } else {
      out[key] = value;
    }
  }
  return { ...(out as unknown as ActivityRow), detail };
}

export const ACTIVITY_CSV_HEADER = [
  'when_utc',
  'when_studio',
  'who',
  'role',
  'kind',
  'what',
  'item_type',
  'item_id',
  'changed_fields',
] as const;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HOUR_MS = 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A writer of "15 Oct 2026, 12:30" in the studio's clock (Admin v2 U9: its zone): the string
 * relTime's formatDateTime prints. Intl costs about 17 µs a call, most of a row's CPU in a
 * 1,000-row file, so the zone's offset is asked once per UTC hour the rows fall in (every
 * listed zone changes its offset only on a whole hour) and the rest is arithmetic.
 * tests/lib/activityExport.spec.ts holds the two equal, across London's and Cairo's changes.
 */
export function studioDateTimeWriter(tz: string = DEFAULT_TIME_ZONE): (at: string) => string {
  const offsets = new Map<number, number>();
  return (at: string) => {
    const time = Date.parse(at);
    if (Number.isNaN(time)) return '';
    const hour = Math.floor(time / HOUR_MS);
    let offset = offsets.get(hour);
    if (offset === undefined) {
      offset = zoneOffsetMs(hour * HOUR_MS, tz);
      offsets.set(hour, offset);
    }
    const d = new Date(time + offset);
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  };
}

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
  tz: string = DEFAULT_TIME_ZONE,
): Promise<ActivityRead> {
  const want = cap + 1;
  const rows: ActivityRow[] = [];
  let before: number | null = null;
  for (let n = 0; n < MAX_PAGES; n += 1) {
    let query = applyFilters(sb.from('audit_log').select(EXPORT_COLUMNS), tenantId, filters, tz);
    if (before !== null) query = query.lt('id', before);
    const { data, error } = await query
      .order('id', { ascending: false })
      .limit(Math.min(PAGE_ROWS, want - rows.length));
    if (error) throw new Error(`activity export: ${error.code ?? 'no code'}`);
    const got = (Array.isArray(data) ? (data as unknown as Record<string, unknown>[]) : []).map(
      withDetail,
    );
    if (got.length === 0) return { rows, truncated: false };
    rows.push(...got);
    if (rows.length >= want) return { rows: rows.slice(0, cap), truncated: true };
    const last = Number(got[got.length - 1]!.id);
    if (!Number.isSafeInteger(last))
      throw new Error('activity export: a row came back without its id');
    before = last;
  }
  return { rows: rows.slice(0, cap), truncated: true };
}

/** The rows as the file's records: names read once for the batch, in chunks of 100. */
export async function toActivityRecords(
  sb: SupabaseClient,
  auth: Pick<AuthContext, 'tenantId'>,
  rows: readonly ActivityRow[],
  tz: string = DEFAULT_TIME_ZONE,
): Promise<Record<string, unknown>[]> {
  const studioDateTime = studioDateTimeWriter(tz);
  const ids = rows.map((row) => row.actor_id).filter((id): id is string => typeof id === 'string');
  const people = ids.length > 0 ? await readPeople(sb, auth.tenantId, ids) : new Map();
  return rows.map((row) => {
    const description = describe(row);
    const who = personOf(row, people);
    return {
      when_utc: typeof row.created_at === 'string' ? new Date(row.created_at).toISOString() : '',
      when_studio: typeof row.created_at === 'string' ? studioDateTime(row.created_at) : '',
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
