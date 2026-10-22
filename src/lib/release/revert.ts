import type { SupabaseClient } from '@supabase/supabase-js';
import type { DraftLabel, DraftOp, RestoreItem, WriteDraftsOp } from '@schemas/release';
import type { AuthContext } from '@/lib/auth/types';
import { mediaRowToItem } from '@/lib/admin/resources/portfolio';
import { canPublish, waitingFor } from './caps';
import { jsonEqual } from './deepEqual';
import { mayRead } from './draftEndpoints';
import { draftLabel, dropFields } from './drafts';
import { RELEASE_LINKS, SEO_TARGET_TABLES } from './links';
import { derivePatch, recordBase, type DerivedPatch } from './overlay';
import type { AsOfTarget } from './asOf';
import { RELEASE_REGISTRY, type RegistryEntry } from './registry';
import { childrenPayload, DERIVED_COLUMNS, restorePatch } from './rowPayload';
import { put, stagedSelect } from './staged';

// What restoring a version would stage (Admin v2 R10; releases.md A3-8, §6.2). SERVER ONLY.
//
// The state at version N is asOf.ts's (the ledger, in one call). The restore (`planRestore`)
// reads it per entity against live, so a column already as it was is not a change, and plans
// what would bring live back to vN, as pending changes:
//   an update  the columns (and a case study's link sets) that differ from live;
//   a create   an entity removed since comes back with its own id;
//   a removal  an entity created since goes;
// refused, entity by entity (each under every reason that applies), when it already has a
// pending change, when the person cannot publish the change (P-2: Admin and the publishers),
// when its image no longer reads as a change (rowPayload.ts), when a link of the version names
// something that is gone and that the restore does not bring back (a deleted picture, a team
// member: never captured), or when its address (a slug, a redirect's source) now belongs to
// another item the restore leaves as it is (releases.md §8 edge case 5: reported, never
// forced). A removal no role publishes (the
// site identity, an entity's SEO details) is left as it is and listed (`kept`). An item of an
// area the person may not read is named by its type alone (no label).
// Team members are never in the ledger (owner item O-12): a version does not hold them, and a
// restore leaves them as they are.

type Row = Record<string, unknown>;
type Payload = Record<string, unknown>;
type Put = Extract<WriteDraftsOp, { action: 'put' }>;

/** One pending change a restore stages. */
export interface PlannedChange {
  entry: RegistryEntry;
  entityId: string;
  op: DraftOp;
  /** The write_drafts op (a new draft: the restore refuses an entity with one pending). */
  write: Put;
  derived: DerivedPatch;
  label: DraftLabel | null;
}

export interface RestorePlan {
  changes: PlannedChange[];
  /** What stops the restore (every entity named). */
  refused: RestoreItem[];
  /** What it leaves as it is, and says so. */
  kept: RestoreItem[];
}

/** Kinds whose change is a full replace (R3b): every column written, `fields` the moved ones. */
const FULL_REPLACE: ReadonlySet<RegistryEntry['kind']> = new Set(['entitySeo', 'pageVisibility']);

const keyOf = (type: string, id: string) => `${type}:${id}`;

/** The live rows of the targets, read under the person's RLS, by type and id. */
async function readLiveRows(
  sb: SupabaseClient,
  auth: AuthContext,
  targets: readonly AsOfTarget[],
): Promise<Map<string, Row>> {
  const byTable = new Map<string, { entry: RegistryEntry; ids: Set<string> }>();
  for (const t of targets) {
    const group = byTable.get(t.entry.table) ?? { entry: t.entry, ids: new Set<string>() };
    group.ids.add(t.entityId);
    byTable.set(t.entry.table, group);
  }
  const out = new Map<string, Row>();
  await Promise.all(
    [...byTable.values()].map(async ({ entry, ids }) => {
      const { data, error } = await sb
        .from(entry.table)
        .select(stagedSelect(entry, `${entry.key},version`))
        .eq('tenant_id', auth.tenantId)
        .in(entry.key, [...ids]);
      if (error) throw new Error(`read ${entry.table}: ${error.message}`);
      for (const row of (data ?? []) as unknown as Row[]) {
        out.set(keyOf(entry.entityType, String(row[entry.key])), row);
      }
    }),
  );
  return out;
}

/** A case study's link sets as they are live, in the payload's shape, by project. */
async function readLiveLinkSets(
  sb: SupabaseClient,
  auth: AuthContext,
  projects: readonly string[],
): Promise<Map<string, Payload>> {
  const out = new Map<string, Payload>();
  if (projects.length === 0) return out;
  for (const id of projects) out.set(id, { serviceIds: [], media: [] });
  const [services, media] = await Promise.all([
    sb
      .from('portfolio_services')
      .select('portfolio_id,service_id,sort_order')
      .eq('tenant_id', auth.tenantId)
      .in('portfolio_id', [...projects])
      .order('sort_order', { ascending: true })
      .order('service_id', { ascending: true }),
    sb
      .from('portfolio_media')
      .select(
        'id,portfolio_id,role,kind,media_id,video_uid,video_path,clip_start_s,clip_end_s,' +
          'duration_label,caption,breakdown_kind,layout,sort_order',
      )
      .eq('tenant_id', auth.tenantId)
      .in('portfolio_id', [...projects])
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true }),
  ]);
  if (services.error) throw new Error(`read portfolio_services: ${services.error.message}`);
  if (media.error) throw new Error(`read portfolio_media: ${media.error.message}`);
  for (const row of (services.data ?? []) as unknown as Row[]) {
    (out.get(String(row['portfolio_id']))?.['serviceIds'] as unknown[] | undefined)?.push(
      row['service_id'],
    );
  }
  for (const row of (media.data ?? []) as unknown as Row[]) {
    (out.get(String(row['portfolio_id']))?.['media'] as unknown[] | undefined)?.push(
      mediaRowToItem(row),
    );
  }
  return out;
}

/** The targets that already have a pending change (any author, claimed or not). */
async function readPending(
  sb: SupabaseClient,
  auth: AuthContext,
  targets: readonly AsOfTarget[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (targets.length === 0) return out;
  const { data, error } = await sb
    .from('content_drafts')
    .select('entity_type,entity_id')
    .eq('tenant_id', auth.tenantId)
    .in('entity_id', [...new Set(targets.map((t) => t.entityId))]);
  if (error) throw new Error(`read pending changes: ${error.message}`);
  for (const row of (data ?? []) as unknown as Row[]) {
    out.add(keyOf(String(row['entity_type']), String(row['entity_id'])));
  }
  return out;
}

const item = (
  entry: RegistryEntry,
  entityId: string,
  labelRow: Row | null | undefined,
  reason: RestoreItem['reason'],
  extra: Partial<RestoreItem> = {},
): RestoreItem => ({
  entityType: entry.entityType,
  entityId,
  label: labelRow ? draftLabel(entry, labelRow) : null,
  reason,
  ...extra,
});

/** Which columns of an update differ from live (derived columns never decide a change). */
function movedColumns(patch: Readonly<Row>, live: Readonly<Row>): string[] {
  return Object.keys(patch).filter(
    (column) =>
      !DERIVED_COLUMNS.includes(column) &&
      !(column in live && jsonEqual(patch[column], live[column])),
  );
}

/** One target → the change that restores it, or why not. */
function planOne(
  t: AsOfTarget,
  live: Row | undefined,
  liveLinks: Payload | undefined,
): {
  change?: Omit<PlannedChange, 'label'> & { labelRow: Row };
  kept?: RestoreItem;
  refused?: RestoreItem;
} {
  const { entry, entityId } = t;
  // Only the link sets moved: restore them on the row as it stands.
  if (t.before === undefined) {
    if (!live || !t.children) return {};
    const children = childrenPayload(t.children);
    if (jsonEqual(children, liveLinks ?? {})) return {};
    let derived: DerivedPatch;
    try {
      derived = derivePatch(entry, 'update', children);
    } catch {
      return {
        refused: item(entry, entityId, live, 'unrestorable', { columns: ['serviceIds', 'media'] }),
      };
    }
    const write = put(
      entry,
      entityId,
      'update',
      children,
      derived,
      {},
      live['version'] as number,
      live,
      null,
    );
    return { change: { entry, entityId, op: 'update', write, derived, labelRow: live } };
  }
  // A visibility setting made since: no setting is what "public" means, so it goes back to
  // public (a release never removes a setting, R2's areas).
  if (t.before === null && live && entry.kind === 'pageVisibility') {
    return planOne(
      {
        ...t,
        before: { ...live, mode: 'public', redirect_page_id: null, hide_from: null, show_on: null },
      },
      live,
      liveLinks,
    );
  }
  // Created since: it goes (if a release may remove it at all).
  if (t.before === null) {
    if (!live) return {};
    const empty: DerivedPatch = { patch: {}, children: {}, exempt: {} };
    if (entry.removeCap === null) return { kept: item(entry, entityId, live, 'kept') };
    const write = put(
      entry,
      entityId,
      'delete',
      {},
      empty,
      {},
      live['version'] as number,
      live,
      null,
    );
    return { change: { entry, entityId, op: 'delete', write, derived: empty, labelRow: live } };
  }
  const before = t.before;
  // Removed since: it comes back, with its own id and its link sets.
  if (!live) {
    const back = restorePatch(entry, 'create', before, t.children);
    if (!back.ok) {
      return { refused: item(entry, entityId, before, 'unrestorable', { columns: back.columns }) };
    }
    const write = put(
      entry,
      entityId,
      'create',
      back.payload,
      back.derived,
      {},
      null,
      before,
      null,
    );
    return {
      change: { entry, entityId, op: 'create', write, derived: back.derived, labelRow: before },
    };
  }
  // Changed since: the columns (and link sets) that differ from live.
  const back = restorePatch(entry, 'update', before, t.children);
  if (!back.ok) {
    return { refused: item(entry, entityId, before, 'unrestorable', { columns: back.columns }) };
  }
  const moved = movedColumns(back.derived.patch, live);
  const linksMoved = t.children !== undefined && !jsonEqual(back.derived.children, liveLinks ?? {});
  if (moved.length === 0 && !linksMoved) return {};

  let payload: Payload;
  let derived: DerivedPatch;
  if (FULL_REPLACE.has(entry.kind)) {
    payload = back.payload;
    derived = back.derived;
  } else {
    payload = dropFields(entry, back.payload, moved);
    if (!linksMoved) for (const key of entry.childKeys) delete payload[key];
    derived = derivePatch(entry, 'update', payload);
  }
  const base = recordBase(null, live, derived.patch);
  const write = put(
    entry,
    entityId,
    'update',
    payload,
    derived,
    base,
    live['version'] as number,
    before,
    null,
  );
  if (FULL_REPLACE.has(entry.kind)) write.fields = moved;
  return { change: { entry, entityId, op: 'update', write, derived, labelRow: before } };
}

/** A link a change writes: the table and id it names, and the field it is on. */
interface Needed {
  table: string;
  id: string;
  field: string;
  change: PlannedChange;
}

/** Every row the restored state links to, per change. */
function neededLinks(changes: readonly PlannedChange[]): Needed[] {
  const out: Needed[] = [];
  for (const change of changes) {
    if (change.op === 'delete') continue;
    const { patch, children } = change.derived;
    for (const spec of RELEASE_LINKS[change.entry.entityType] ?? []) {
      // A team member's account link is never restored (team members are not in the ledger).
      if (spec.service) continue;
      const value = patch[spec.column];
      if (typeof value === 'string')
        out.push({ table: spec.table, id: value, field: spec.field, change });
    }
    if (change.entry.kind === 'entitySeo' && change.op === 'create') {
      const table = SEO_TARGET_TABLES[String(patch['entity_type'])];
      if (table && typeof patch['entity_id'] === 'string') {
        out.push({ table, id: patch['entity_id'], field: 'entityId', change });
      }
    }
    if (Array.isArray(children['serviceIds'])) {
      for (const id of children['serviceIds']) {
        if (typeof id === 'string')
          out.push({ table: 'services', id, field: 'serviceIds', change });
      }
    }
    if (Array.isArray(children['media'])) {
      for (const media of children['media'] as Row[]) {
        const id = media?.['mediaId'];
        if (typeof id === 'string') out.push({ table: 'media_assets', id, field: 'media', change });
      }
    }
  }
  return out;
}

/**
 * The links of the restored state that name nothing: a row that is gone now and that the
 * restore does not bring back (or that the restore itself removes). Existence is read under the
 * person's RLS, in the tenant (ids only): every CMS role reads the registry tables and the media
 * library.
 */
async function goneLinks(
  sb: SupabaseClient,
  auth: AuthContext,
  changes: readonly PlannedChange[],
): Promise<RestoreItem[]> {
  const created = new Set<string>();
  const removed = new Set<string>();
  for (const c of changes) {
    if (c.op === 'create') created.add(keyOf(c.entry.table, c.entityId));
    if (c.op === 'delete') removed.add(keyOf(c.entry.table, c.entityId));
  }
  const needed = neededLinks(changes);
  const ask = new Map<string, Set<string>>();
  for (const n of needed) {
    const k = keyOf(n.table, n.id);
    if (created.has(k) || removed.has(k)) continue;
    const ids = ask.get(n.table) ?? new Set<string>();
    ids.add(n.id);
    ask.set(n.table, ids);
  }
  const present = new Set<string>();
  await Promise.all(
    [...ask].map(async ([table, ids]) => {
      const { data, error } = await sb
        .from(table)
        .select('id')
        .eq('tenant_id', auth.tenantId)
        .in('id', [...ids]);
      if (error) throw new Error(`read ${table}: ${error.message}`);
      for (const row of (data ?? []) as unknown as Row[])
        present.add(keyOf(table, String(row['id'])));
    }),
  );
  const out: RestoreItem[] = [];
  const seen = new Set<string>();
  for (const n of needed) {
    const k = keyOf(n.table, n.id);
    if (created.has(k) || (!removed.has(k) && present.has(k))) continue;
    const once = `${n.change.entry.entityType}:${n.change.entityId}:${n.field}`;
    if (seen.has(once)) continue;
    seen.add(once);
    out.push({
      entityType: n.change.entry.entityType,
      entityId: n.change.entityId,
      label: n.change.label,
      reason: 'link-gone',
      field: n.field,
    });
  }
  return out;
}

/**
 * What restoring these targets would stage, read against live: the changes, what stops it, and
 * what it leaves as it is. Nothing is written here.
 */
export async function planRestore(
  sb: SupabaseClient,
  auth: AuthContext,
  targets: readonly AsOfTarget[],
): Promise<RestorePlan> {
  const projects = targets
    .filter((t) => t.entry.entityType === 'portfolio' && t.children !== undefined)
    .map((t) => t.entityId);
  const [live, links, pending] = await Promise.all([
    readLiveRows(sb, auth, targets),
    readLiveLinkSets(sb, auth, projects),
    readPending(sb, auth, targets),
  ]);

  const changes: PlannedChange[] = [];
  // Every change the restore means to make, refused ones included: what it brings back or
  // removes, for the link and address checks, so each refused entity is named under every
  // reason in one answer and none is blamed for another's refusal.
  const intended: PlannedChange[] = [];
  const refused: RestoreItem[] = [];
  const kept: RestoreItem[] = [];
  for (const t of targets) {
    const row = live.get(keyOf(t.entry.entityType, t.entityId));
    const planned = planOne(t, row, links.get(t.entityId));
    if (planned.refused) refused.push(planned.refused);
    if (planned.kept) kept.push(planned.kept);
    if (!planned.change) continue;
    const { labelRow, ...change } = planned.change;
    const full: PlannedChange = { ...change, label: draftLabel(t.entry, labelRow) };
    intended.push(full);
    if (pending.has(keyOf(t.entry.entityType, t.entityId))) {
      refused.push({ ...item(t.entry, t.entityId, labelRow, 'pending') });
      continue;
    }
    // What publishing it needs: a removal or an archive, or (hotfix H12) an edit that leaves a
    // row archived live archived, is an Admin's.
    const ref = {
      entityType: t.entry.entityType,
      op: full.op,
      patch:
        typeof full.derived.patch['status'] === 'string'
          ? { status: full.derived.patch['status'] }
          : null,
      liveStatus: typeof row?.['status'] === 'string' ? row['status'] : null,
    } as const;
    if (!canPublish(auth.role, ref)) {
      refused.push(
        item(t.entry, t.entityId, labelRow, 'forbidden', { waitingFor: waitingFor(ref) }),
      );
      continue;
    }
    changes.push(full);
  }
  const [gone, taken] = await Promise.all([
    goneLinks(sb, auth, intended),
    takenAddresses(sb, auth, intended),
  ]);
  refused.push(...gone, ...taken);
  // An area the person may not read: its type and id, never its words.
  const named = (r: RestoreItem): RestoreItem =>
    r.label !== null && !mayRead(auth.role, RELEASE_REGISTRY[r.entityType])
      ? { ...r, label: null }
      : r;
  return { changes, refused: refused.map(named), kept: kept.map(named) };
}

/** The column that is unique per tenant on a registry table: a slug, a redirect's source. */
function addressColumn(entry: RegistryEntry): string | null {
  if (entry.entityType === 'redirect') return 'source_path';
  return entry.columns.includes('slug') ? 'slug' : null;
}

/**
 * The changes whose address (slug, redirect source) another live item now holds, one that the
 * restore leaves as it is (one it removes or gives another address is the apply's to order: a
 * swap within one release is the dry run's to report, edge case 6). The unique index would
 * refuse the publish; the restore says so first. Read under the person's RLS, in the tenant.
 */
async function takenAddresses(
  sb: SupabaseClient,
  auth: AuthContext,
  changes: readonly PlannedChange[],
): Promise<RestoreItem[]> {
  const moving = new Set<string>();
  const asked = new Map<string, { entry: RegistryEntry; column: string; values: Set<string> }>();
  for (const c of changes) {
    const column = addressColumn(c.entry);
    if (!column) continue;
    if (c.op === 'delete' || column in c.derived.patch)
      moving.add(keyOf(c.entry.table, c.entityId));
    const value = c.derived.patch[column];
    if (c.op === 'delete' || typeof value !== 'string') continue;
    const group = asked.get(c.entry.table) ?? { entry: c.entry, column, values: new Set<string>() };
    group.values.add(value);
    asked.set(c.entry.table, group);
  }
  const holders = new Map<string, string[]>();
  await Promise.all(
    [...asked.values()].map(async ({ entry, column, values }) => {
      const { data, error } = await sb
        .from(entry.table)
        .select(`id,${column}`)
        .eq('tenant_id', auth.tenantId)
        .in(column, [...values]);
      if (error) throw new Error(`read ${entry.table}: ${error.message}`);
      for (const row of (data ?? []) as unknown as Row[]) {
        // A slug is citext: compared without case, as the unique index compares it.
        const k = keyOf(entry.table, String(row[column]).toLowerCase());
        holders.set(k, [...(holders.get(k) ?? []), String(row['id'])]);
      }
    }),
  );
  const out: RestoreItem[] = [];
  for (const c of changes) {
    const column = addressColumn(c.entry);
    const value = column ? c.derived.patch[column] : undefined;
    if (c.op === 'delete' || !column || typeof value !== 'string') continue;
    const others = (holders.get(keyOf(c.entry.table, value.toLowerCase())) ?? []).filter(
      (id) => id !== c.entityId && !moving.has(keyOf(c.entry.table, id)),
    );
    if (others.length === 0) continue;
    out.push({
      entityType: c.entry.entityType,
      entityId: c.entityId,
      label: c.label,
      reason: 'address-taken',
      field:
        Object.entries(c.entry.fields).find(([, cols]) => cols.includes(column))?.[0] ?? column,
    });
  }
  return out;
}
