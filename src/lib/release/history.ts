import type { SupabaseClient } from '@supabase/supabase-js';
import { VERSIONS_PAGE, type HistoryQuery } from '@schemas/release';
import type { AuthContext } from '@/lib/auth/types';
import { AuthorizationError } from '@/lib/authz/errors';
import { json, type AdminRouteContext } from '@/lib/admin/route';
import { readsEntity } from '@/lib/preview/dataset';
import { canPublish } from './caps';
import { RELEASE_REGISTRY } from './registry';
import { namesOf, type Person } from './versions';

// One entity's history (Admin v2 R10; releases.md §6.2, §7 "History drawer", §8 edge case 23).
// SERVER ONLY. `GET /api/admin/history?entityType&entityId`:
//
//   scope=item  its numbered snapshots (content_versions, 0104's `seq`: 1, 2, 3 … in the order
//               they were written), newest first, a page of 50 (`before=<seq>` for older): when,
//               who (the staff directory's name), the row's own version, and the site version
//               that made it (null for a save made while releases were off); whether it is live
//               now or was removed (and in which version); its pending change, if any.
//   scope=page  a page: every site version that changed the page or one of its sections (the
//               page editor's history; "Restore" is the page-scoped restore of that version).
//
// The person must read the entity's area (its registry read capabilities, as the editor's own
// gate); history rows are CMS staff's under RLS (content_versions_read, 0001/0038). Team members
// keep no history (owner item O-12): their list is empty.

type Row = Record<string, unknown>;
type Ctx = AdminRouteContext<HistoryQuery>;

/** Ledger items read per query of a page's history (a page's and its sections' changes). */
const PAGE_ITEMS_MAX = 1000;

export interface HistoryVersion {
  seq: number;
  /** The row's own version when it was saved. */
  version: number;
  at: string;
  by: Person | null;
  release: { id: string; number: number | null } | null;
  /** The newest snapshot of a row that exists: what the site shows now. */
  live: boolean;
}

async function releaseNumbers(
  sb: SupabaseClient,
  auth: AuthContext,
  ids: readonly string[],
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (ids.length === 0) return out;
  const { data, error } = await sb
    .from('content_releases')
    .select('id,number')
    .eq('tenant_id', auth.tenantId)
    .in('id', [...ids]);
  if (error) throw new Error(`read versions: ${error.message}`);
  for (const row of (data ?? []) as unknown as Row[]) {
    out.set(String(row['id']), typeof row['number'] === 'number' ? row['number'] : null);
  }
  return out;
}

/** `GET /api/admin/history`. */
export async function entityHistory(ctx: Ctx): Promise<unknown> {
  const { sb, auth, input } = ctx;
  const entry = RELEASE_REGISTRY[input.entityType];
  if (!readsEntity(auth.role, entry)) {
    throw new AuthorizationError(entry.readCaps.join('|'), `history of ${entry.entityType}`);
  }
  if (input.scope === 'page') {
    if (entry.entityType !== 'page') {
      return json(
        {
          ok: false,
          error: 'validation',
          field: 'scope',
          detail: 'Only a page has a page history.',
        },
        422,
      );
    }
    return pageHistory(ctx);
  }

  let versions = sb
    .from('content_versions')
    .select('seq,version,created_at,created_by,release_id')
    .eq('tenant_id', auth.tenantId)
    .eq('entity_type', entry.entityType)
    .eq('entity_id', input.entityId);
  if (input.before !== undefined) versions = versions.lt('seq', input.before);
  const [enabled, page, live, pending, names] = await Promise.all([
    ctx.releasesEnabled(),
    versions.order('seq', { ascending: false }).limit(VERSIONS_PAGE + 1),
    sb
      .from(entry.table)
      .select(entry.key)
      .eq('tenant_id', auth.tenantId)
      .eq(entry.key, input.entityId)
      .maybeSingle(),
    sb
      .from('content_drafts')
      .select('id,version,op,fields,updated_by,updated_at,release_id,origin_kind')
      .eq('tenant_id', auth.tenantId)
      .eq('entity_type', entry.entityType)
      .eq('entity_id', input.entityId)
      .maybeSingle(),
    namesOf(sb, auth),
  ]);
  if (page.error) throw new Error(`read history: ${page.error.message}`);
  if (live.error) throw new Error(`read ${entry.table}: ${live.error.message}`);
  if (pending.error) throw new Error(`read pending change: ${pending.error.message}`);

  const rows = ((page.data ?? []) as unknown as Row[]).slice(0, VERSIONS_PAGE);
  const exists = live.data !== null && live.data !== undefined;
  const numbers = await releaseNumbers(sb, auth, [
    ...new Set(rows.map((r) => r['release_id']).filter((v): v is string => typeof v === 'string')),
  ]);

  // A removed entity: the version that removed it (the ledger's delete item), when one did.
  let removed: { release: { id: string; number: number | null } | null; at: string } | null = null;
  if (!exists) {
    const { data, error } = await sb
      .from('content_release_items')
      .select('release_id,created_at')
      .eq('tenant_id', auth.tenantId)
      .eq('entity_type', entry.entityType)
      .eq('entity_id', input.entityId)
      .eq('op', 'delete')
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`read removal: ${error.message}`);
    const hit = data as Row | null;
    if (hit) {
      const id = typeof hit['release_id'] === 'string' ? hit['release_id'] : null;
      const more = id ? await releaseNumbers(sb, auth, [id]) : new Map<string, number | null>();
      removed = {
        release: id ? { id, number: more.get(id) ?? null } : null,
        at: String(hit['created_at']),
      };
    }
  }

  const draft = pending.data as Row | null;
  const named = (id: unknown): Person | null =>
    typeof id === 'string' ? { id, name: names.get(id) ?? null } : null;
  return {
    entity: { entityType: entry.entityType, entityId: input.entityId },
    enabled,
    live: exists,
    removed,
    // Restoring stages a change: who may publish one of this type (P-2), with releases on.
    restorable: enabled && canPublish(auth.role, { entityType: entry.entityType, op: 'update' }),
    pending: draft
      ? {
          draftId: String(draft['id']),
          draftVersion: Number(draft['version']),
          op: String(draft['op']),
          fields: Array.isArray(draft['fields']) ? draft['fields'] : [],
          by: named(draft['updated_by']),
          at: String(draft['updated_at']),
          scheduled: typeof draft['release_id'] === 'string',
          restore: draft['origin_kind'] === 'restore',
        }
      : null,
    versions: rows.map((r, i): HistoryVersion => ({
      seq: Number(r['seq']),
      version: Number(r['version']),
      at: String(r['created_at']),
      by: named(r['created_by']),
      release:
        typeof r['release_id'] === 'string'
          ? { id: r['release_id'], number: numbers.get(r['release_id']) ?? null }
          : null,
      live: i === 0 && input.before === undefined && exists,
    })),
    more: ((page.data ?? []) as unknown[]).length > VERSIONS_PAGE,
  };
}

/** The site versions that changed a page or one of its sections, newest first. */
async function pageHistory(ctx: Ctx): Promise<unknown> {
  const { sb, auth, input } = ctx;
  const page = input.entityId;
  // Items naming the page, and items of sections whose image before or after names it (a
  // section moved between pages counts for both); the ledger's (tenant, type, entity) index
  // serves each. Items no release made (out-of-band writes) belong to no version.
  const items = (column: 'entity_id' | 'before->>page_id' | 'after->>page_id') =>
    sb
      .from('content_release_items')
      .select('release_id')
      .eq('tenant_id', auth.tenantId)
      .eq('entity_type', column === 'entity_id' ? 'page' : 'page_section')
      .eq(column, page)
      .limit(PAGE_ITEMS_MAX);
  const [own, before, after, names, enabled] = await Promise.all([
    items('entity_id'),
    items('before->>page_id'),
    items('after->>page_id'),
    namesOf(sb, auth),
    ctx.releasesEnabled(),
  ]);
  for (const read of [own, before, after]) {
    if (read.error) throw new Error(`read page history: ${read.error.message}`);
  }
  const ids = [
    ...new Set(
      [own, before, after]
        .flatMap((read) => (read.data ?? []) as Row[])
        .map((r) => r['release_id'])
        .filter((v): v is string => typeof v === 'string'),
    ),
  ];
  let rows: Row[] = [];
  if (ids.length > 0) {
    let q = sb
      .from('content_releases')
      .select('id,number,kind,note,published_at,published_by')
      .eq('tenant_id', auth.tenantId)
      .eq('status', 'published')
      .in('id', ids);
    if (input.before !== undefined) q = q.lt('number', input.before);
    const { data, error } = await q.order('number', { ascending: false }).limit(VERSIONS_PAGE + 1);
    if (error) throw new Error(`read versions: ${error.message}`);
    rows = (data ?? []) as unknown as Row[];
  }
  return {
    entity: { entityType: 'page', entityId: page },
    enabled,
    restorable: enabled && canPublish(auth.role, { entityType: 'page', op: 'update' }),
    versions: rows.slice(0, VERSIONS_PAGE).map((r) => ({
      id: String(r['id']),
      number: typeof r['number'] === 'number' ? r['number'] : null,
      kind: String(r['kind']),
      note: typeof r['note'] === 'string' ? r['note'] : null,
      publishedAt: typeof r['published_at'] === 'string' ? r['published_at'] : null,
      publishedBy:
        typeof r['published_by'] === 'string'
          ? { id: r['published_by'], name: names.get(r['published_by']) ?? null }
          : null,
    })),
    more: rows.length > VERSIONS_PAGE,
  };
}
