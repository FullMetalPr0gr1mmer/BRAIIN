import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ActivityQuerySchema,
  type ActivityFilters,
  type ActivityQuery,
} from '@schemas/audit';
import type { AuthContext, Role } from '@/lib/auth/types';
import { isRole } from '@/lib/auth/types';
import { ROLE_LABELS } from '@/lib/authz/capLabels';
import { describe, kindFilter, type ActivityDescription, type ActivityRow } from './auditLabels';
import { resolveTitles, titleKey } from './auditTitles';
import { PAGE_SIZE, offsetOf } from './pager';

// The activity log's reads (Admin v2 U13), shared by the page (/admin/audit), its JSON twin
// (GET /api/admin/audit) and the CSV export (GET /api/admin/audit/export). Every read goes
// through the viewer's own client, so RLS decides what is seen: audit_read (Admin and
// Developer by the token) and, since 0054, audit_log_live_read (the same by the live
// profile), each with the tenant predicate first; the Worker names the tenant too.
//
// A page costs (README P-15, 50 subrequests): the page of rows with its exact count, the
// chain check, the names, at most 8 title reads (src/lib/admin/auditTitles.ts), and on the
// page the people directory for the person filter: 12 at most. The count is `exact` on a
// small table; past ~100k rows, `planned` would do (docs/admin-v2/as-built/U13.md).

/** The columns a page or a file reads. Never the hashes, which only the chain check reads. */
const ROW_COLUMNS = 'id,actor_id,actor_role,action,entity_type,entity_id,detail,created_at';

/** How many of the newest entries the chain check walks. */
export const CHAIN_WINDOW = 100;

/** The studio's offset from UTC (Asia/Riyadh: +03:00 all year, no daylight saving). */
const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The first instant of a Riyadh day, as the UTC ISO string Postgres compares with. */
export function riyadhDayStart(day: string): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date) - RIYADH_OFFSET_MS).toISOString();
}

/** The first instant AFTER a Riyadh day: `to` is inclusive of its whole day. */
export function riyadhDayEnd(day: string): string {
  return new Date(Date.parse(riyadhDayStart(day)) + DAY_MS).toISOString();
}

/**
 * What applyFilters calls on a query. PostgREST's builder types are generic over the table's
 * row and every filter's column, which TypeScript cannot follow through a helper shared by
 * three reads, so the helper sees the builder as this and hands it back as it came.
 */
interface Filterable {
  eq(column: string, value: unknown): Filterable;
  gte(column: string, value: unknown): Filterable;
  lt(column: string, value: unknown): Filterable;
  or(filters: string): Filterable;
}

/** The filters, applied in one place for the page, its count and the export. */
export function applyFilters<T>(query: T, tenantId: string, filters: ActivityFilters): T {
  let q = (query as unknown as Filterable).eq('tenant_id', tenantId);
  if (filters.actor) q = q.eq('actor_id', filters.actor);
  if (filters.from) q = q.gte('created_at', riyadhDayStart(filters.from));
  if (filters.to) q = q.lt('created_at', riyadhDayEnd(filters.to));
  if (filters.entityType) q = q.eq('entity_type', filters.entityType);
  if (filters.entityId) q = q.eq('entity_id', filters.entityId);
  if (filters.kind) q = q.or(kindFilter(filters.kind));
  return q as unknown as T;
}

// ── The chain ────────────────────────────────────────────────────────────────────────────

export interface ChainReport {
  /** How many entries were walked (the newest CHAIN_WINDOW). */
  checked: number;
  contiguous: boolean;
  /** The first entry, newest first, whose `prev_hash` is not the hash of the one before it. */
  brokenAt: number | null;
}

/**
 * Walks the newest entries, newest first: each should carry the hash of the one before it as
 * its `prev_hash` (0031: id order is chain order). This catches an entry deleted or moved;
 * it cannot catch a rewritten one, whose hash only the trigger's Vault key can recompute
 * (the hourly R2-anchor verifier's job, CLAUDE.md §10). It must read the log UNFILTERED: two
 * neighbours on a filtered page are not neighbours in the chain.
 */
export function verifyChain(rows: readonly Record<string, unknown>[]): ChainReport {
  for (let i = 0; i < rows.length - 1; i += 1) {
    const newer = rows[i];
    const older = rows[i + 1];
    if (!newer || !older) continue;
    if (newer['prev_hash'] !== older['hash']) {
      return { checked: rows.length, contiguous: false, brokenAt: Number(newer['id']) };
    }
  }
  return { checked: rows.length, contiguous: true, brokenAt: null };
}

async function readChain(sb: SupabaseClient, tenantId: string): Promise<ChainReport | null> {
  try {
    const { data, error } = await sb
      .from('audit_log')
      .select('id,prev_hash,hash')
      .eq('tenant_id', tenantId)
      .order('id', { ascending: false })
      .limit(CHAIN_WINDOW);
    if (error || !Array.isArray(data)) return null;
    return verifyChain(data as Record<string, unknown>[]);
  } catch {
    return null;
  }
}

// ── People ───────────────────────────────────────────────────────────────────────────────

export interface ActivityPerson {
  id: string | null;
  name: string;
  /** The role the entry was written under (the token's, bound by 0050), when it is one. */
  role: Role | null;
  roleLabel: string | null;
  /** Switched off, or gone from the team: not in the directory, so not in the person select. */
  former: boolean;
  /** The profile was read: `name` is the person's own (else a stand-in, "A former member"). */
  known: boolean;
}

interface Profile {
  id: string;
  display_name: string | null;
  role: string;
  is_active: boolean;
}

/** The most ids public.audit_people answers at a time (0054: 22023 above). */
export const PEOPLE_CHUNK = 100;

/**
 * The people `ids` name, through the directory's audit door (public.audit_people, 0054):
 * former members included, for a live Admin or Developer. A read that fails names nobody,
 * and the entries read "Someone"; the rest of the page still renders.
 */
export async function readPeople(
  sb: SupabaseClient,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, Profile>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, Profile>();
  for (let i = 0; i < unique.length; i += PEOPLE_CHUNK) {
    const { data, error } = await sb.rpc('audit_people', {
      p_tenant: tenantId,
      p_ids: unique.slice(i, i + PEOPLE_CHUNK),
    });
    if (error) throw new Error(`audit people: ${error.code ?? 'no code'}`);
    for (const person of (Array.isArray(data) ? data : []) as Profile[]) {
      if (typeof person?.id === 'string') out.set(person.id, person);
    }
  }
  return out;
}

/** Who an entry names, in words. */
export function personOf(
  row: Pick<ActivityRow, 'actor_id' | 'actor_role'>,
  people: ReadonlyMap<string, Profile> | null,
): ActivityPerson {
  const role = isRole(row.actor_role) ? row.actor_role : null;
  const roleLabel = role ? ROLE_LABELS[role] : null;
  if (!row.actor_id) {
    // The service role's rows about no account (a reset asked for by a visitor) and an
    // operator's.
    return { id: null, name: 'No account', role, roleLabel, former: false, known: false };
  }
  if (!people) {
    return { id: row.actor_id, name: 'Someone', role, roleLabel, former: false, known: false };
  }
  const person = people.get(row.actor_id);
  if (!person) {
    // No profile left: a member removed from the team altogether.
    return { id: row.actor_id, name: 'A former member', role, roleLabel, former: true, known: false };
  }
  const name = (person.display_name ?? '').trim() || 'A member with no name';
  return {
    id: row.actor_id,
    name,
    role,
    roleLabel,
    former: person.is_active !== true,
    known: true,
  };
}

// ── A page ───────────────────────────────────────────────────────────────────────────────

export interface ActivityEntry {
  id: string;
  /** The ISO instant (`created_at`, the database's clock since 0050). */
  at: string;
  who: ActivityPerson;
  description: ActivityDescription;
  title: string | null;
  itemType: string | null;
  itemId: string | null;
}

export interface ActivityPage {
  entries: ActivityEntry[];
  total: number;
  /** The page shown: the one asked for, or the last one when that is past the end. */
  page: number;
  chain: ChainReport | null;
  /** The people a page's actor names were read for, by id (the person select uses them). */
  people: ReadonlyMap<string, ActivityPerson>;
}

function asRows(data: unknown): ActivityRow[] {
  return (Array.isArray(data) ? data : []) as ActivityRow[];
}

/** One page of entries, newest first, and the count of all that match. */
async function readPage(
  sb: SupabaseClient,
  tenantId: string,
  query: ActivityQuery,
  page: number,
): Promise<{ rows: ActivityRow[]; total: number; outOfRange: boolean }> {
  const offset = offsetOf(page, PAGE_SIZE);
  const { data, error, count } = await applyFilters(
    sb.from('audit_log').select(ROW_COLUMNS, { count: 'exact' }),
    tenantId,
    query,
  )
    .order('id', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);
  // PGRST103: the page asked for is past the end (PostgREST answers 416).
  if (error?.code === 'PGRST103') return { rows: [], total: count ?? 0, outOfRange: true };
  if (error) throw new Error(`activity page: ${error.code ?? 'no code'}`);
  return { rows: asRows(data), total: count ?? 0, outOfRange: false };
}

/** How many entries match: for a page asked past the end, whose answer carried no count. */
async function countMatching(
  sb: SupabaseClient,
  tenantId: string,
  query: ActivityQuery,
): Promise<number> {
  const { error, count } = await applyFilters(
    sb.from('audit_log').select('id', { count: 'exact', head: true }),
    tenantId,
    query,
  );
  if (error) throw new Error(`activity count: ${error.code ?? 'no code'}`);
  return count ?? 0;
}

/**
 * The page the query asks for, described: names, titles (never for people or their data:
 * auditTitles.ts) and the changed fields' names; plus the chain check over the newest
 * entries, unfiltered. `extraPeople` are ids to name besides the page's actors (the person
 * the filter names, so the select can show them when they have left).
 */
export async function loadActivity(
  sb: SupabaseClient,
  auth: Pick<AuthContext, 'tenantId'>,
  query: ActivityQuery,
  extraPeople: readonly string[] = [],
): Promise<ActivityPage> {
  const tenantId = auth.tenantId;
  const [first, chain] = await Promise.all([
    readPage(sb, tenantId, query, query.page),
    readChain(sb, tenantId),
  ]);

  let read = first;
  let page = query.page;
  if (read.outOfRange || (read.rows.length === 0 && page > 1)) {
    const total = read.outOfRange && read.total === 0 ? await countMatching(sb, tenantId, query) : read.total;
    const last = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (last < page) {
      page = last;
      read = await readPage(sb, tenantId, query, last);
    }
  }

  const descriptions = read.rows.map((row) => describe(row));
  const actorIds = [
    ...read.rows.map((row) => row.actor_id).filter((id): id is string => typeof id === 'string'),
    ...extraPeople,
  ];
  const [people, titles] = await Promise.all([
    actorIds.length > 0
      ? readPeople(sb, tenantId, actorIds.slice(0, PEOPLE_CHUNK)).catch(() => null)
      : Promise.resolve(new Map<string, Profile>()),
    resolveTitles(
      sb,
      { tenantId },
      descriptions.map((d) => d.titleRef),
    ),
  ]);

  const named = new Map<string, ActivityPerson>();
  for (const id of extraPeople) named.set(id, personOf({ actor_id: id, actor_role: null }, people));

  const entries = read.rows.map((row, i): ActivityEntry => {
    const description = descriptions[i]!;
    const ref = description.titleRef;
    const who = personOf(row, people);
    if (who.id) named.set(who.id, who);
    return {
      id: String(row.id),
      at: row.created_at,
      who,
      description,
      title: ref ? (titles.get(titleKey(ref.type, ref.id.toLowerCase())) ?? null) : null,
      itemType: typeof row.entity_type === 'string' ? row.entity_type : null,
      itemId: typeof row.entity_id === 'string' ? row.entity_id : null,
    };
  });

  return { entries, total: read.total, page, chain, people: named };
}

// ── The page's own reading of its URL ────────────────────────────────────────────────────

const QUERY_KEYS = ['kind', 'actor', 'from', 'to', 'entityType', 'entityId', 'page'] as const;

/**
 * The page's filters from its URL, leniently: a value that does not parse is left out (and
 * named in `dropped`, so the page can say so) rather than refusing the page. Other keys (the
 * export's notice) are not filters.
 */
export function readActivityQuery(params: URLSearchParams): {
  query: ActivityQuery;
  dropped: string[];
} {
  const raw: Record<string, string> = {};
  for (const key of QUERY_KEYS) {
    const value = params.get(key);
    if (value !== null) raw[key] = value;
  }
  const whole = ActivityQuerySchema.safeParse(raw);
  if (whole.success) return { query: whole.data, dropped: [] };

  const dropped: string[] = [];
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const alone = ActivityQuerySchema.safeParse({ [key]: value });
    if (alone.success) kept[key] = value;
    else dropped.push(key);
  }
  const query = ActivityQuerySchema.safeParse(kept);
  return { query: query.success ? query.data : ActivityQuerySchema.parse({}), dropped };
}

/** The filters as URL parameters, in a fixed order (the chips, the pager, the export link). */
export function filterParams(filters: ActivityFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of ['kind', 'actor', 'from', 'to', 'entityType', 'entityId'] as const) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  return params;
}

/** A role's label, for a person the select names. */
export function roleLabelOf(role: unknown): string | null {
  return isRole(role) ? ROLE_LABELS[role] : null;
}
