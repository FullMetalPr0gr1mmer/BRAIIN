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
  /**
   * The reads the plan would have needed, when they were more than its budget: nothing past the
   * budget was read, and the restore is refused before anything is staged (P-15).
   */
  overBudget?: number;
}

export interface PlanOptions {
  /** The most reads the plan may send (the request's 50 subrequests, less the rest of it). */
  budget?: number;
}

/**
 * A quote's consent record (0028's consent gate, PDPL): a fact about now, never a version's to
 * bring back. A restore never writes these columns, never brings back a quote removed since
 * (its consent may have been withdrawn: it is added again, with consent recorded again), and
 * never publishes a quote whose consent is not recorded now.
 */
const CONSENT_COLUMNS: Readonly<Partial<Record<string, readonly string[]>>> = {
  testimonial: ['consent_obtained_at', 'consent_reference'],
};

/** Whether a change leaves a quote live (published or scheduled) with no consent recorded now. */
function liveWithoutConsent(entry: RegistryEntry, patch: Readonly<Row>, live: Readonly<Row>) {
  if (!CONSENT_COLUMNS[entry.entityType]) return false;
  const status = typeof patch['status'] === 'string' ? patch['status'] : live['status'];
  const sample = (patch['is_placeholder'] ?? live['is_placeholder']) === true;
  return (
    (status === 'published' || status === 'scheduled') &&
    !sample &&
    (live['consent_obtained_at'] === null || live['consent_obtained_at'] === undefined)
  );
}

/** Kinds whose change is a full replace (R3b): every column written, `fields` the moved ones. */
const FULL_REPLACE: ReadonlySet<RegistryEntry['kind']> = new Set(['entitySeo', 'pageVisibility']);

const keyOf = (type: string, id: string) => `${type}:${id}`;

/** Rows of the tenant whose presence is known: the ids asked of each table, and those found. */
interface Known {
  asked: Map<string, Set<string>>;
  found: Set<string>;
}

/** Ids by table, a set per table. */
function addTo(map: Map<string, Set<string>>, table: string, id: unknown): void {
  if (typeof id !== 'string') return;
  const ids = map.get(table) ?? new Set<string>();
  ids.add(id);
  map.set(table, ids);
}

/**
 * Every row the targets' images at the version link to, by table (P-15): asked with the live
 * rows of a table the restore reads anyway, so the links of the state it brings back cost a
 * read only on a table it does not otherwise read (the media library, team members). A superset
 * of the links a change writes: an edit writes the image's own values of the columns that
 * moved, a create all of them, and link sets the ledger's.
 */
function imageLinks(targets: readonly AsOfTarget[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const t of targets) {
    const image = t.before;
    if (image) {
      for (const spec of RELEASE_LINKS[t.entry.entityType] ?? []) {
        if (!spec.service) addTo(out, spec.table, image[spec.column]);
      }
      if (t.entry.kind === 'entitySeo') {
        const table = SEO_TARGET_TABLES[String(image['entity_type'])];
        if (table) addTo(out, table, image['entity_id']);
      }
    }
    const sets = t.children;
    if (Array.isArray(sets?.service_ids)) {
      for (const id of sets.service_ids as unknown[]) addTo(out, 'services', id);
    }
    if (Array.isArray(sets?.media)) {
      for (const row of sets.media as Row[]) addTo(out, 'media_assets', row?.['media_id']);
    }
  }
  return out;
}

/** The tables the live read asks, each with its entry and the ids it asks for. */
function liveQueries(
  targets: readonly AsOfTarget[],
  links: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, { entry: RegistryEntry; ids: Set<string> }> {
  const byTable = new Map<string, { entry: RegistryEntry; ids: Set<string> }>();
  for (const t of targets) {
    const group = byTable.get(t.entry.table) ?? { entry: t.entry, ids: new Set<string>() };
    group.ids.add(t.entityId);
    byTable.set(t.entry.table, group);
  }
  // A table keyed by id that the images link to: those ids join its read.
  for (const { entry, ids } of byTable.values()) {
    if (entry.key !== 'id') continue;
    for (const id of links.get(entry.table) ?? []) ids.add(id);
  }
  return byTable;
}

/**
 * The live rows of the targets, read under the person's RLS, by type and id; and, for the
 * tables read, which of the ids asked are there (a link to any of them is then known).
 */
async function readLiveRows(
  sb: SupabaseClient,
  auth: AuthContext,
  queries: ReadonlyMap<string, { entry: RegistryEntry; ids: Set<string> }>,
): Promise<{ rows: Map<string, Row>; known: Known }> {
  const rows = new Map<string, Row>();
  const known: Known = { asked: new Map(), found: new Set() };
  await Promise.all(
    [...queries.values()].map(async ({ entry, ids }) => {
      const { data, error } = await sb
        .from(entry.table)
        .select(stagedSelect(entry, `${entry.key},version`))
        .eq('tenant_id', auth.tenantId)
        .in(entry.key, [...ids]);
      if (error) throw new Error(`read ${entry.table}: ${error.message}`);
      if (entry.key === 'id') known.asked.set(entry.table, ids);
      for (const row of (data ?? []) as unknown as Row[]) {
        rows.set(keyOf(entry.entityType, String(row[entry.key])), row);
        if (entry.key === 'id') known.found.add(keyOf(entry.table, String(row['id'])));
      }
    }),
  );
  return { rows, known };
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

/**
 * The round trip's change cut down to the payload's keys: the columns those keys write (their
 * `fields`, which name every column a key writes or feeds, so keys that feed one column stay
 * together), with the values the whole image derived, and their link sets. Deriving the
 * trimmed payload again would give the same columns (tests/lib/resourceFields.spec.ts) at the
 * cost of a second parse and, for a rich-text body, a second render (P-15: 10 ms of CPU).
 */
export function narrowed(
  entry: RegistryEntry,
  whole: DerivedPatch,
  payload: Readonly<Payload>,
): DerivedPatch {
  const columns = new Set(Object.keys(payload).flatMap((key) => entry.fields[key] ?? []));
  const keep = (from: Readonly<Row>) =>
    Object.fromEntries(Object.entries(from).filter(([column]) => columns.has(column)));
  return {
    patch: keep(whole.patch),
    children: Object.fromEntries(Object.entries(whole.children).filter(([key]) => key in payload)),
    exempt: keep(whole.exempt),
  };
}

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
  // A quote removed since stays removed: its consent is not a version's to bring back.
  if (!live && CONSENT_COLUMNS[entry.entityType]) {
    return { refused: item(entry, entityId, before, 'consent') };
  }
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
  // Never the consent record: it stays as it is now.
  const consent = CONSENT_COLUMNS[entry.entityType] ?? [];
  const moved = movedColumns(back.derived.patch, live).filter((c) => !consent.includes(c));
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
    derived = narrowed(entry, back.derived, payload);
  }
  if (liveWithoutConsent(entry, derived.patch, live)) {
    return { refused: item(entry, entityId, before, 'consent') };
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

/** The rows these changes create and remove, by table and id. */
function movesOf(changes: readonly PlannedChange[]): {
  created: Set<string>;
  removed: Set<string>;
} {
  const created = new Set<string>();
  const removed = new Set<string>();
  for (const c of changes) {
    if (c.op === 'create') created.add(keyOf(c.entry.table, c.entityId));
    if (c.op === 'delete') removed.add(keyOf(c.entry.table, c.entityId));
  }
  return { created, removed };
}

/** What the links of these changes need asked: the ids the live read did not already ask. */
function linkQueries(changes: readonly PlannedChange[], known: Known): Map<string, Set<string>> {
  const { created, removed } = movesOf(changes);
  const ask = new Map<string, Set<string>>();
  for (const n of neededLinks(changes)) {
    const k = keyOf(n.table, n.id);
    if (created.has(k) || removed.has(k) || known.asked.get(n.table)?.has(n.id)) continue;
    addTo(ask, n.table, n.id);
  }
  return ask;
}

/**
 * The links of the restored state that name nothing: a row that is gone now and that the
 * restore does not bring back (or that the restore itself removes). Existence is read under the
 * person's RLS, in the tenant (ids only): every CMS role reads the registry tables and the media
 * library. `known` is what the live read already saw; `ask` (linkQueries) the rest.
 */
async function goneLinks(
  sb: SupabaseClient,
  auth: AuthContext,
  changes: readonly PlannedChange[],
  known: Known,
  ask: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<RestoreItem[]> {
  const { created, removed } = movesOf(changes);
  const present = new Set<string>(known.found);
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
  for (const n of neededLinks(changes)) {
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
  options: PlanOptions = {},
): Promise<RestorePlan> {
  const budget = options.budget ?? Infinity;
  const projects = targets
    .filter((t) => t.entry.entityType === 'portfolio' && t.children !== undefined)
    .map((t) => t.entityId);
  const queries = liveQueries(targets, imageLinks(targets));
  // The reads, counted before they are sent (P-15): the live rows (one per table), a case
  // study's link sets (two), the pending changes (one).
  const first = queries.size + (projects.length > 0 ? 2 : 0) + (targets.length > 0 ? 1 : 0);
  if (first > budget) return { changes: [], refused: [], kept: [], overBudget: first };
  const [{ rows: live, known }, links, pending] = await Promise.all([
    readLiveRows(sb, auth, queries),
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
  // Then one read per table a link names that the live read did not ask, and one per table
  // whose addresses the restore writes: counted first, and past the budget nothing is read.
  const linksAsked = linkQueries(intended, known);
  const addressesAsked = addressQueries(intended);
  const total = first + linksAsked.size + addressesAsked.size;
  if (total > budget) return { changes: [], refused: [], kept: [], overBudget: total };
  const [gone, taken] = await Promise.all([
    goneLinks(sb, auth, intended, known, linksAsked),
    takenAddresses(sb, auth, intended, addressesAsked),
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

/** An address read: the table's entry, its address column and the values asked. */
interface AddressQuery {
  entry: RegistryEntry;
  column: string;
  values: Set<string>;
}

/** The address reads a set of changes needs: per table, the addresses it writes. */
function addressQueries(changes: readonly PlannedChange[]): Map<string, AddressQuery> {
  const asked = new Map<string, AddressQuery>();
  for (const c of changes) {
    const column = addressColumn(c.entry);
    const value = column ? c.derived.patch[column] : undefined;
    if (!column || c.op === 'delete' || typeof value !== 'string') continue;
    const group = asked.get(c.entry.table) ?? { entry: c.entry, column, values: new Set<string>() };
    group.values.add(value);
    asked.set(c.entry.table, group);
  }
  return asked;
}

/**
 * The changes whose address (slug, redirect source) another live item now holds, one that the
 * restore leaves as it is (one it removes or gives another address is the apply's to order: a
 * swap within one release is the dry run's to report, edge case 6). The unique index would
 * refuse the publish; the restore says so first. Read under the person's RLS, in the tenant;
 * `asked` is addressQueries' answer for these changes.
 */
async function takenAddresses(
  sb: SupabaseClient,
  auth: AuthContext,
  changes: readonly PlannedChange[],
  asked: ReadonlyMap<string, AddressQuery>,
): Promise<RestoreItem[]> {
  const moving = new Set<string>();
  for (const c of changes) {
    const column = addressColumn(c.entry);
    if (column && (c.op === 'delete' || column in c.derived.patch)) {
      moving.add(keyOf(c.entry.table, c.entityId));
    }
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
