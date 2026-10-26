import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  RELEASE_ENTITY_TYPES,
  VERSION_ITEMS_MAX,
  VERSIONS_PAGE,
  type ReleaseEntityType,
} from '@schemas/release';
import type { AuthContext } from '@/lib/auth/types';
import { json, type AdminRouteContext } from '@/lib/admin/route';
import { readsEntity } from '@/lib/preview/dataset';
import { jsonEqual } from './deepEqual';
import { RELEASE_REGISTRY, type RegistryEntry } from './registry';
import { DERIVED_COLUMNS } from './rowPayload';

// The site's numbered versions (Admin v2 R10; releases.md §6.1, §7 "Versions page"). SERVER ONLY.
// Read under the person's RLS: `content_releases` and `content_release_items` are CMS staff's
// (0038), so a Sales token, another tenant or anon reads none. R13 draws the page on these.
//
//   GET /api/admin/releases          the versions, newest first (a page of 50, `?before=N` for
//                                    older), with what is scheduled or failed on top;
//   GET /api/admin/releases/[id]     one version's changes, each entity the person may read
//                                    with what changed: before and after for plain text and
//                                    bilingual fields, "changed" for the rest (rich text, lists,
//                                    a case study's link sets), never a consent reference.
//
// Releases off (every tenant until R14): no version exists, so the list is empty and every id is
// not found; `enabled` says which, for the page's "Publishing is switched off" line.

type Row = Record<string, unknown>;
type Ctx = AdminRouteContext<unknown>;

const Uuid = z.string().uuid();

/**
 * The release columns a version shows (never the frozen payload or a failure's message). Its
 * `version` is what moving or cancelling a scheduled release names (R11).
 */
const RELEASE_COLUMNS =
  'id,number,kind,status,note,scheduled_for,scheduled_by,published_at,published_by,' +
  'restores_release_id,item_count,areas,purge_status,failure_code:failure->>code,version';

/** A person, named when the staff directory knows them. */
export interface Person {
  id: string;
  name: string | null;
}

/** The staff directory (F8): names by id; empty when it cannot be read (the list still stands). */
export async function namesOf(
  sb: SupabaseClient,
  auth: AuthContext,
): Promise<Map<string, string | null>> {
  const names = new Map<string, string | null>();
  const { data, error } = await sb.rpc('staff_directory', { p_tenant: auth.tenantId });
  if (error || !Array.isArray(data)) return names;
  for (const p of data as Row[]) {
    if (typeof p['id'] === 'string') {
      names.set(p['id'], typeof p['display_name'] === 'string' ? p['display_name'] : null);
    }
  }
  return names;
}

const person = (names: Map<string, string | null>, id: unknown): Person | null =>
  typeof id === 'string' ? { id, name: names.get(id) ?? null } : null;

/** One version as the list shows it. */
export interface VersionSummary {
  id: string;
  number: number | null;
  kind: string;
  status: string;
  note: string | null;
  publishedAt: string | null;
  publishedBy: Person | null;
  scheduledFor: string | null;
  scheduledBy: Person | null;
  itemCount: number;
  areas: string[];
  /** The version a rollback restored. */
  restores: number | null;
  purge: string;
  failure: string | null;
  /** The version the site shows now (the highest published number). */
  live: boolean;
  /** The row's own version: what a move or a cancel of a scheduled release names (R11). */
  version: number;
}

function summary(
  row: Row,
  names: Map<string, string | null>,
  numbers: Map<string, number>,
  liveNumber: number | null,
): VersionSummary {
  const number = typeof row['number'] === 'number' ? row['number'] : null;
  return {
    id: String(row['id']),
    number,
    kind: String(row['kind']),
    status: String(row['status']),
    note: typeof row['note'] === 'string' ? row['note'] : null,
    publishedAt: typeof row['published_at'] === 'string' ? row['published_at'] : null,
    publishedBy: person(names, row['published_by']),
    scheduledFor: typeof row['scheduled_for'] === 'string' ? row['scheduled_for'] : null,
    scheduledBy: person(names, row['scheduled_by']),
    itemCount: typeof row['item_count'] === 'number' ? row['item_count'] : 0,
    areas: Array.isArray(row['areas']) ? (row['areas'] as unknown[]).map(String) : [],
    restores:
      typeof row['restores_release_id'] === 'string'
        ? (numbers.get(row['restores_release_id']) ?? null)
        : null,
    purge: String(row['purge_status'] ?? 'pending'),
    failure: typeof row['failure_code'] === 'string' ? row['failure_code'] : null,
    live: number !== null && number === liveNumber,
    version: typeof row['version'] === 'number' ? row['version'] : 1,
  };
}

/** The numbers of the versions these rollbacks restored that the page does not hold. */
async function restoredNumbers(
  sb: SupabaseClient,
  auth: AuthContext,
  rows: readonly Row[],
): Promise<Map<string, number>> {
  const numbers = new Map<string, number>();
  for (const row of rows) {
    if (typeof row['number'] === 'number') numbers.set(String(row['id']), row['number']);
  }
  const missing = [
    ...new Set(
      rows
        .map((r) => r['restores_release_id'])
        .filter((id): id is string => typeof id === 'string' && !numbers.has(id)),
    ),
  ];
  if (missing.length === 0) return numbers;
  const { data, error } = await sb
    .from('content_releases')
    .select('id,number')
    .eq('tenant_id', auth.tenantId)
    .in('id', missing);
  if (error) throw new Error(`read restored versions: ${error.message}`);
  for (const row of (data ?? []) as unknown as Row[]) {
    if (typeof row['number'] === 'number') numbers.set(String(row['id']), row['number']);
  }
  return numbers;
}

/** `GET /api/admin/releases`. */
export async function listVersions(ctx: Ctx, before: number | undefined): Promise<unknown> {
  const { sb, auth } = ctx;
  let published = sb
    .from('content_releases')
    .select(RELEASE_COLUMNS)
    .eq('tenant_id', auth.tenantId)
    .eq('status', 'published');
  if (before !== undefined) published = published.lt('number', before);
  const [enabled, page, upcoming, names] = await Promise.all([
    ctx.releasesEnabled(),
    published.order('number', { ascending: false }).limit(VERSIONS_PAGE + 1),
    before === undefined
      ? sb
          .from('content_releases')
          .select(RELEASE_COLUMNS)
          .eq('tenant_id', auth.tenantId)
          .in('status', ['scheduled', 'failed'])
          .order('created_at', { ascending: false })
          .limit(VERSIONS_PAGE)
      : Promise.resolve({ data: [], error: null }),
    namesOf(sb, auth),
  ]);
  if (page.error) throw new Error(`read versions: ${page.error.message}`);
  if (upcoming.error) throw new Error(`read scheduled versions: ${upcoming.error.message}`);
  const rows = ((page.data ?? []) as unknown as Row[]).slice(0, VERSIONS_PAGE);
  const others = (upcoming.data ?? []) as unknown as Row[];
  const numbers = await restoredNumbers(sb, auth, [...rows, ...others]);
  // The live version is the newest published one: on the first page, its first row.
  const liveNumber =
    before === undefined && typeof rows[0]?.['number'] === 'number'
      ? (rows[0]['number'] as number)
      : null;
  return {
    enabled,
    live: liveNumber,
    versions: rows.map((r) => summary(r, names, numbers, liveNumber)),
    upcoming: others.map((r) => summary(r, names, numbers, null)),
    more: ((page.data ?? []) as unknown[]).length > VERSIONS_PAGE,
  };
}

// ---- one version's changes -------------------------------------------------------------------

/** What a version's change shows of one field. */
export interface FieldChange {
  column: string;
  /** `text` and `bilingual` carry both values; `changed` only says it changed. */
  kind: 'text' | 'bilingual' | 'changed';
  before?: unknown;
  after?: unknown;
}

/** Bookkeeping columns: never a change a person made. */
const NOISE: ReadonlySet<string> = new Set([
  'id',
  'tenant_id',
  'version',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
  'published_at',
  ...DERIVED_COLUMNS,
]);

/** Columns whose values a version never shows (a quote's consent record: name and change only). */
const VALUE_HIDDEN: ReadonlySet<string> = new Set(['consent_reference', 'consent_obtained_at']);

/** The longest text a version shows of one value. */
export const FIELD_TEXT_MAX = 300;

const clip = (value: unknown): unknown =>
  typeof value === 'string' && value.length > FIELD_TEXT_MAX
    ? `${value.slice(0, FIELD_TEXT_MAX)}…`
    : value;

const isScalar = (v: unknown) =>
  v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v);

const isBilingual = (v: unknown) =>
  v === null ||
  v === undefined ||
  (typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.entries(v as Row).every(
      ([k, x]) => (k === 'en' || k === 'ar') && (x === null || typeof x === 'string'),
    ));

/** The fields one item changed, before and after where they read as plain or bilingual text. */
export function fieldChanges(before: Row | null, after: Row | null): FieldChange[] {
  const columns = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const out: FieldChange[] = [];
  for (const column of [...columns].sort()) {
    if (NOISE.has(column) || column.startsWith('search_')) continue;
    const b = before?.[column] ?? null;
    const a = after?.[column] ?? null;
    if (jsonEqual(b, a)) continue;
    if (VALUE_HIDDEN.has(column)) {
      out.push({ column, kind: 'changed' });
    } else if (isScalar(b) && isScalar(a)) {
      out.push({ column, kind: 'text', before: clip(b), after: clip(a) });
    } else if (isBilingual(b) && isBilingual(a)) {
      const bi = (v: unknown) =>
        v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v as Row).map(([k, x]) => [k, clip(x)]))
          : null;
      out.push({ column, kind: 'bilingual', before: bi(b), after: bi(a) });
    } else {
      out.push({ column, kind: 'changed' });
    }
  }
  return out;
}

const isRegistryType = (type: string): type is ReleaseEntityType =>
  (RELEASE_ENTITY_TYPES as readonly string[]).includes(type);

/** The registry entry an item belongs to (a case study's link sets: the case study's). */
function entryOfItem(type: string): RegistryEntry | null {
  if (type === 'portfolio_children') return RELEASE_REGISTRY.portfolio;
  return isRegistryType(type) ? RELEASE_REGISTRY[type] : null;
}

/** `GET /api/admin/releases/[id]`. */
export async function versionDetail(ctx: Ctx): Promise<unknown> {
  const { sb, auth, params } = ctx;
  const id = Uuid.safeParse(params['id']);
  if (!id.success) return json({ ok: false, error: 'not-found', entity: 'release' }, 404);
  const [release, items, names] = await Promise.all([
    sb
      .from('content_releases')
      .select(RELEASE_COLUMNS)
      .eq('tenant_id', auth.tenantId)
      .eq('id', id.data)
      .maybeSingle(),
    sb
      .from('content_release_items')
      .select('id,entity_type,entity_id,op,before,after,draft_id')
      .eq('tenant_id', auth.tenantId)
      .eq('release_id', id.data)
      .order('id', { ascending: true })
      .limit(VERSION_ITEMS_MAX + 1),
    namesOf(sb, auth),
  ]);
  if (release.error) throw new Error(`read version: ${release.error.message}`);
  if (items.error) throw new Error(`read version items: ${items.error.message}`);
  if (!release.data) return json({ ok: false, error: 'not-found', entity: 'release' }, 404);
  const row = release.data as unknown as Row;
  const numbers = await restoredNumbers(sb, auth, [row]);

  const all = ((items.data ?? []) as unknown as Row[]).slice(0, VERSION_ITEMS_MAX);
  let hidden = 0;
  const shown = [];
  for (const item of all) {
    const type = String(item['entity_type']);
    const entry = entryOfItem(type);
    // An area the person may not read is counted, never listed (as the pending summary does).
    if (!entry || !readsEntity(auth.role, entry)) {
      hidden += 1;
      continue;
    }
    const before = (item['before'] ?? null) as Row | null;
    const after = (item['after'] ?? null) as Row | null;
    const linkSets = type === 'portfolio_children';
    shown.push({
      id: Number(item['id']),
      entityType: type,
      entityId: String(item['entity_id']),
      op: String(item['op']),
      area: entry.area,
      label: linkSets ? null : entry.label({ ...(after ?? before ?? {}) }),
      /** A cascade or a side write the release caused (no pending change of its own). */
      cascade: item['draft_id'] === null,
      fields: linkSets
        ? [
            ...(jsonEqual(before?.['service_ids'], after?.['service_ids'])
              ? []
              : [{ column: 'service_ids', kind: 'changed' as const }]),
            ...(jsonEqual(before?.['media'], after?.['media'])
              ? []
              : [{ column: 'media', kind: 'changed' as const }]),
          ]
        : fieldChanges(before, after),
    });
  }
  return {
    release: summary(row, names, numbers, null),
    items: shown,
    hidden,
    truncated: ((items.data ?? []) as unknown[]).length > VERSION_ITEMS_MAX,
  };
}
