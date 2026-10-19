import { z } from 'zod';
import { DraftRefFieldsSchema, type DraftOp, type WriteDraftsOp } from '@schemas/release';
import { assertCap } from '@/lib/authz/matrix';
import type { AuthContext } from '@/lib/auth/types';
import type { AdminRouteContext } from '@/lib/admin/route';
import type { ResourceConfig, ResourcePayload } from '@/lib/admin/resource';
import { assertStatusTransition, getRowOrNull, listRows } from '@/lib/admin/crud';
import {
  DraftConflictError,
  NotFoundError,
  OptimisticLockError,
  ValidationError,
} from '@/lib/admin/errors';
import {
  derivePatch,
  dropNoOps,
  mergePayload,
  overlayList,
  overlayRow,
  recordBase,
  type DerivedPatch,
  type DraftMeta,
} from './overlay';
import { registryByTable, type RegistryEntry } from './registry';
import { pendingDb } from './layers';
import {
  draftFields,
  draftLabel,
  draftWasPublished,
  dropFields,
  loadDraft,
  loadDraftsOf,
  shouldAudit,
  writeDrafts,
  writtenDraft,
  type StoredDraft,
} from './drafts';

// The staged branch of the resource kernel (Admin v2 R3a; docs/admin-v2/releases.md §3).
// SERVER ONLY: it reaches the release registry, which imports every resource config.
//
// With releases on for the caller's tenant, src/lib/admin/resource.ts hands every request on
// a release-managed table here, one line at the top of each handler, after the kernel's gate:
//
//   const entry = stagedEntry(config);
//   if (entry && (await ctx.releasesEnabled())) return staged<Op>(config, entry, ctx, …);
//
// and its legacy body below stays as it is (the contract slice, R15, removes it). Here a save
// becomes a pending change in content_drafts instead of a live write, and a read lays the
// pending change over live. The rules every staged write follows:
//   • the live read selects the whole writable allowlist (stagedSelect): `recordBase` reads
//     `live[column] ?? null`, so a column missing from the select would record a false null
//     base, which the publish (R4) would refuse as a conflict;
//   • the payload is stored camelCase through `mergePayload`, and re-derived with
//     `derivePatch` (the schema and `toRow`, no `published_at`, no per-item schedule);
//   • stage time runs the status capabilities (`stageTransition`, the legacy save's rule) and
//     `assertWritable` over live ⊕ patch, its reads through `pendingDb` (R6: live with every
//     pending change laid over it, so a link to a pending create passes), never
//     `assertPublishable` (D6: publish and the dry run run it);
//   • never `persist`, `afterWrite` or `afterDelete`: save_portfolio, theme deactivation and the
//     redirects' KV sync belong to the apply (R4) and R7. Child sets stay in the payload.

type Row = Record<string, unknown>;
type Payload = Record<string, unknown>;
type Ctx = AdminRouteContext<unknown>;
type Put = Extract<WriteDraftsOp, { action: 'put' }>;

/** The registry entry a kernel route stages through, or undefined (media, Style-Finder). */
export function stagedEntry(config: ResourceConfig): RegistryEntry | undefined {
  const entry = registryByTable(config.table);
  return entry?.kind === 'resource' ? entry : undefined;
}

/** The top-level names of a PostgREST select list (an embed by its name, an alias by itself). */
function selectNames(list: string): Set<string> {
  const out = new Set<string>();
  let depth = 0;
  let current = '';
  const flush = () => {
    const name = current.trim().replace(/\(.*$/s, '').split(':')[0]!.trim();
    if (name) out.add(name);
    current = '';
  };
  for (const ch of list) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) flush();
    else current += ch;
  }
  flush();
  return out;
}

/**
 * A live select that covers the writable allowlist: `columns` plus every column of
 * `entry.columns`, the key and `version` it does not already name.
 */
export function stagedSelect(entry: RegistryEntry, columns: string): string {
  const have = selectNames(columns);
  if (have.has('*')) return columns;
  const extra = [...new Set([...entry.columns, entry.key, 'version'])].filter((c) => !have.has(c));
  return extra.length > 0 ? `${columns},${extra.join(',')}` : columns;
}

const shape = (config: ResourceConfig, row: Row): Row =>
  config.fromRow ? config.fromRow(row) : row;

/**
 * The legacy save's status rule, at stage time (resource.ts `assertTransition`): publishing or
 * scheduling needs `content.publish`, archiving `content.archiveDelete`, and `visible: true` on
 * a `visible`-published entity needs `content.publish`.
 */
export function stageTransition(auth: AuthContext, config: ResourceConfig, payload: Payload): void {
  assertStatusTransition(auth, config.statusOf?.(payload));
  if (config.publishFlag === 'visible' && payload['visible'] === true) {
    assertCap(auth, 'content.publish');
  }
}

const target = (config: ResourceConfig) => ({ entity: config.entity, cap: config.writeCap });

export const pick = (row: Readonly<Row>, keys: Iterable<string>): Row => {
  const out: Row = {};
  for (const key of keys) if (key in row) out[key] = row[key];
  return out;
};

/** The draft meta of a draft whose payload no longer parses (written around the API). */
export function invalidMeta(draft: StoredDraft): DraftMeta & { invalid: true } {
  return {
    id: draft.id,
    version: draft.version,
    op: draft.op,
    fields: [],
    updatedBy: draft.updated_by,
    updatedAt: draft.updated_at,
    releaseId: draft.release_id,
    invalid: true,
  };
}

/** A put op, every field stated (the writer's shape is strict). */
export function put(
  entry: RegistryEntry,
  entityId: string,
  op: DraftOp,
  payload: Payload,
  derived: DerivedPatch,
  base: Row,
  baseVersion: number | null,
  labelRow: Row,
  previous: StoredDraft | null,
): Put {
  return {
    action: 'put',
    entity_type: entry.entityType,
    entity_id: entityId,
    op,
    payload: op === 'delete' ? {} : payload,
    fields: op === 'delete' ? [] : draftFields(derived),
    base: op === 'delete' ? {} : base,
    base_version: op === 'create' ? null : baseVersion,
    label: draftLabel(entry, labelRow),
    ...(previous ? { draft_id: previous.id, expected_version: previous.version } : {}),
  };
}

// ---- reads ------------------------------------------------------------------------------------

export interface StagedListQuery {
  filters: Record<string, string>;
  exclude: Record<string, string>;
  search: { column: string; term: string } | undefined;
  limit: number;
  offset: number;
}

/** GET list: today's live page with the entity type's pending changes laid over it. */
export async function stagedList(
  config: ResourceConfig,
  entry: RegistryEntry,
  ctx: Ctx,
  query: StagedListQuery,
): Promise<Row> {
  const { auth, sb } = ctx;
  const [live, loaded] = await Promise.all([
    listRows<Row>(sb, config.table, auth, {
      columns: config.listColumns,
      orderBy: config.orderBy,
      filters: query.filters,
      exclude: query.exclude,
      search: query.search,
      limit: query.limit,
      offset: query.offset,
    }),
    loadDraftsOf(sb, auth, entry.entityType),
  ]);
  const overlaid = overlayList(
    live,
    loaded.drafts,
    {
      filters: query.filters,
      exclude: query.exclude,
      search: query.search,
      offset: query.offset,
      orderBy: config.orderBy,
    },
    entry,
  );
  return {
    rows: overlaid.rows,
    total: overlaid.total,
    limit: query.limit,
    offset: query.offset,
    draftsInvalid: [...loaded.invalid, ...overlaid.invalid],
    draftsTruncated: loaded.truncated,
  };
}

/** GET item: live with its pending change laid over it, and the change's meta. */
export async function stagedRead(
  config: ResourceConfig,
  entry: RegistryEntry,
  ctx: Ctx,
  id: string,
): Promise<Row> {
  const { auth, sb } = ctx;
  const [live, draft] = await Promise.all([
    getRowOrNull<Row>(sb, config.table, auth, id, stagedSelect(entry, config.columns)),
    loadDraft(sb, auth, entry.entityType, id),
  ]);
  if (!draft) {
    if (!live) throw new NotFoundError(config.table);
    return { ...shape(config, live), draft: null };
  }
  try {
    const { row, draft: meta } = overlayRow(live, draft, entry);
    return row ? { ...row, draft: meta } : { [entry.key]: id, version: null, draft: meta };
  } catch {
    // A payload that no longer parses: show live, and say so (R6's dry run reports it).
    if (!live) throw new NotFoundError(config.table);
    return { ...shape(config, live), draft: invalidMeta(draft) };
  }
}

// ---- writes -----------------------------------------------------------------------------------

/** POST: a pending create under a Worker-allocated id. */
export async function stagedCreate(
  config: ResourceConfig,
  entry: RegistryEntry,
  ctx: Ctx,
  input: unknown,
): Promise<Row> {
  const { auth, sb, audit } = ctx;
  const payload = input as ResourcePayload;
  // Creating something already published is a publish (as the legacy POST says).
  stageTransition(auth, config, payload);
  const merged = mergePayload(null, payload, entry);
  const derived = derivePatch(entry, 'create', merged);
  await config.assertWritable?.(derived.patch, {
    auth,
    sb,
    changed: derived.patch,
    db: pendingDb(sb, auth),
  });

  // Never the client's: a create's key is the Worker's, so other drafts can link to it.
  const entityId = crypto.randomUUID();
  const op = put(entry, entityId, 'create', merged, derived, {}, null, derived.patch, null);
  const [written] = await writeDrafts(sb, auth, [op], target(config));
  const { row, draft } = overlayRow(null, writtenDraft(op, written!, auth, null), entry);
  audit({
    action: `${config.entity}.draft_save`,
    entityType: config.entity,
    entityId,
    detail: { op: 'create', fields: draft.fields, status: derived.patch['status'] ?? null },
  });
  return { ...row, draft };
}

/** What a staged PATCH reads: the update schema's payload, and the draft it names (if any). */
function parsePatch(
  config: ResourceConfig,
  raw: unknown,
): {
  payload: ResourcePayload & { version?: number };
  ref: { draftId: string; draftVersion: number } | null;
} {
  const body = z.record(z.string(), z.unknown()).parse(raw);
  const { draftId, draftVersion, ...rest } = body;
  const ref = DraftRefFieldsSchema.parse({ draftId, draftVersion });
  // With a draft named, the live version is not what the save is checked against (a pending
  // create has none): the schema still asks for one, so the draft's stands in.
  const payload = config.updateSchema.parse(
    ref.draftId !== undefined && (rest['version'] === undefined || rest['version'] === 0)
      ? { ...rest, version: ref.draftVersion }
      : rest,
  ) as ResourcePayload & { version?: number };
  return {
    payload,
    ref:
      ref.draftId !== undefined && ref.draftVersion !== undefined
        ? { draftId: ref.draftId, draftVersion: ref.draftVersion }
        : null,
  };
}

/** PATCH: merge into the item's pending change (or start one), drop what equals live. */
export async function stagedUpdate(
  config: ResourceConfig,
  entry: RegistryEntry,
  ctx: Ctx,
  id: string,
  raw: unknown,
): Promise<Row> {
  const { auth, sb, audit } = ctx;
  const { payload, ref } = parsePatch(config, raw);
  stageTransition(auth, config, payload);
  const childFields = (config.childKeys ?? []).filter((key) => payload[key] !== undefined);
  if (Object.keys(config.toRow(payload)).length === 0 && childFields.length === 0) {
    throw new ValidationError('no updatable fields supplied');
  }

  const [live, draft] = await Promise.all([
    getRowOrNull<Row>(sb, config.table, auth, id, stagedSelect(entry, config.columns)),
    loadDraft(sb, auth, entry.entityType, id),
  ]);

  if (draft) {
    if (draft.release_id !== null) throw new DraftConflictError('scheduled', config.entity);
    if (!ref || ref.draftId !== draft.id || ref.draftVersion !== draft.version) {
      throw new DraftConflictError('draft-conflict', config.entity);
    }
    if (draft.op === 'delete') {
      throw new DraftConflictError(
        'draft-conflict',
        config.entity,
        null,
        'This item is being removed. Undo the removal first.',
      );
    }
    if (draft.op === 'update' && !live) {
      throw new DraftConflictError(
        'draft-conflict',
        config.entity,
        null,
        'This item was removed on the live site. Discard the change.',
      );
    }
  } else if (ref) {
    // The change the form was editing is gone: published (a release item names it) or thrown
    // away. Either way the live row comes back, so the form keeps the editor's values.
    const published = await draftWasPublished(sb, auth, ref.draftId);
    throw new DraftConflictError(
      published ? 'draft-published' : 'draft-discarded',
      config.entity,
      live ? shape(config, live) : null,
    );
  } else {
    if (!live) throw new NotFoundError(config.table);
    if (payload.version !== live['version']) throw new OptimisticLockError(config.table);
  }

  const op: DraftOp = draft?.op === 'create' ? 'create' : 'update';
  let stored = mergePayload(draft?.payload, payload, entry);
  // The status rule over the whole pending change: re-saving someone else's staged archive or
  // publish is staging it too (RLS refuses an archive draft from a non-Admin as well).
  stageTransition(auth, config, stored);
  let derived = derivePatch(entry, op, stored);
  if (op === 'update') {
    const remaining = dropNoOps(derived.patch, live!, draft?.base);
    stored = dropFields(entry, stored, Object.keys(remaining ?? {}));
    if (Object.keys(stored).length === 0) {
      // Nothing differs from live: no pending change remains.
      if (draft) {
        await writeDrafts(
          sb,
          auth,
          [{ action: 'discard', draft_id: draft.id, expected_version: draft.version }],
          target(config),
        );
        audit({
          action: `${config.entity}.draft_discard`,
          entityType: config.entity,
          entityId: id,
          detail: { op: draft.op, reason: 'no-op' },
        });
      }
      return { ...shape(config, live!), draft: null };
    }
    derived = derivePatch(entry, 'update', stored);
  }

  const merged = op === 'create' ? derived.patch : { ...live!, ...derived.patch };
  await config.assertWritable?.(merged, {
    auth,
    sb,
    changed: derived.patch,
    db: pendingDb(sb, auth, { table: entry.table, id }),
  });

  // The base: each patched column's live value when it was first patched, never overwritten,
  // and only for the columns the change still writes.
  const base =
    op === 'create'
      ? {}
      : pick(recordBase(draft?.base, live, derived.patch), Object.keys(derived.patch));
  const baseVersion =
    op === 'create' ? null : (draft?.base_version ?? (live!['version'] as number));
  const write = put(entry, id, op, stored, derived, base, baseVersion, merged, draft);
  const [written] = await writeDrafts(sb, auth, [write], target(config));
  const result = overlayRow(live, writtenDraft(write, written!, auth, draft), entry);
  if (shouldAudit(draft, auth, op)) {
    audit({
      action: `${config.entity}.draft_save`,
      entityType: config.entity,
      entityId: id,
      detail: { op, fields: result.draft.fields },
    });
  }
  return { ...(result.row ?? { [entry.key]: id }), draft: result.draft };
}

/** DELETE: stage a removal of a live row, or discard a pending create. */
export async function stagedDelete(
  config: ResourceConfig,
  entry: RegistryEntry,
  ctx: Ctx,
  id: string,
): Promise<Row> {
  const { auth, sb, audit, url } = ctx;
  const sent = url.searchParams.get('draftVersion');
  const draftVersion = sent === null ? null : z.coerce.number().int().min(1).safeParse(sent);
  if (draftVersion && !draftVersion.success) {
    throw new ValidationError('draftVersion must be a positive integer', 'draftVersion');
  }
  const [live, draft] = await Promise.all([
    getRowOrNull<Row>(sb, config.table, auth, id, stagedSelect(entry, config.columns)),
    loadDraft(sb, auth, entry.entityType, id),
  ]);
  if (draft?.release_id) throw new DraftConflictError('scheduled', config.entity);
  if (draftVersion?.success && draftVersion.data !== draft?.version) {
    throw new DraftConflictError('draft-conflict', config.entity);
  }

  if (draft?.op === 'create') {
    await writeDrafts(
      sb,
      auth,
      [
        {
          action: 'discard',
          draft_id: draft.id,
          expected_version: draft.version,
          entity_type: entry.entityType,
          entity_id: id,
        },
      ],
      target(config),
    );
    audit({
      action: `${config.entity}.draft_discard`,
      entityType: config.entity,
      entityId: id,
      detail: { op: 'create', fields: draft.fields },
    });
    return { deleted: id, draft: null };
  }
  if (!live) {
    if (!draft) throw new NotFoundError(config.table);
    throw new DraftConflictError(
      'draft-conflict',
      config.entity,
      null,
      'This item was removed on the live site. Discard the change.',
    );
  }
  if (draft?.op === 'delete') {
    // Already pending removal: nothing to write.
    const { draft: meta } = overlayRow(live, draft, entry);
    return { deleted: id, pendingRemoval: true, draft: meta };
  }

  // A pending edit is replaced by the removal (D11); the audit row names what it threw away.
  const write = put(
    entry,
    id,
    'delete',
    {},
    { patch: {}, children: {}, exempt: {} },
    {},
    draft?.base_version ?? (live['version'] as number),
    live,
    draft,
  );
  const [written] = await writeDrafts(sb, auth, [write], target(config));
  const { draft: meta } = overlayRow(live, writtenDraft(write, written!, auth, draft), entry);
  audit({
    action: `${config.entity}.draft_save`,
    entityType: config.entity,
    entityId: id,
    detail: { op: 'delete', replaced: draft?.fields ?? [] },
  });
  return { deleted: id, pendingRemoval: true, draft: meta };
}

/** Reorder: every moved row's `sortOrder` into its pending change, in one writer call. */
export async function stagedReorder(
  config: ResourceConfig,
  entry: RegistryEntry,
  ctx: Ctx,
  items: readonly { id: string; sortOrder: number }[],
): Promise<Row> {
  const { auth, sb, audit } = ctx;
  // The last position given for an id wins, as the legacy loop's last UPDATE did.
  const order = new Map(items.map((item) => [item.id, item.sortOrder]));
  const ids = [...order.keys()];
  const { drafts } = await loadDraftsOf(sb, auth, entry.entityType, { entityIds: ids });
  const draftOf = new Map(drafts.map((d) => [d.entity_id, d]));
  // A row with a pending change has its base read over the whole allowlist; otherwise the
  // sort order and version are all a reorder needs.
  const narrow = `${entry.key},sort_order,version`;
  const { data, error } = await sb
    .from(config.table)
    .select(drafts.length > 0 ? stagedSelect(entry, narrow) : narrow)
    .eq('tenant_id', auth.tenantId)
    .in(entry.key, ids);
  if (error) throw new Error(`reorder ${config.table}: ${error.message}`);
  const liveOf = new Map(((data ?? []) as unknown as Row[]).map((r) => [String(r[entry.key]), r]));

  const ops: WriteDraftsOp[] = [];
  for (const [id, sortOrder] of order) {
    const draft = draftOf.get(id) ?? null;
    const live = liveOf.get(id) ?? null;
    if (draft?.release_id) throw new DraftConflictError('scheduled', config.entity);
    if (draft?.op === 'delete') continue; // a pending removal keeps its place until it goes
    if (!live && draft?.op !== 'create') continue; // not this tenant's row: nothing to move
    const op: DraftOp = draft?.op === 'create' ? 'create' : 'update';
    let stored = mergePayload(draft?.payload, { sortOrder }, entry);
    stageTransition(auth, config, stored);
    let derived = derivePatch(entry, op, stored);
    if (op === 'update') {
      const remaining = dropNoOps(derived.patch, live!, draft?.base);
      stored = dropFields(entry, stored, Object.keys(remaining ?? {}));
      if (Object.keys(stored).length === 0) {
        if (draft) {
          ops.push({
            action: 'discard',
            draft_id: draft.id,
            expected_version: draft.version,
            entity_type: entry.entityType,
            entity_id: id,
          });
        }
        continue;
      }
      derived = derivePatch(entry, 'update', stored);
    }
    const base =
      op === 'create'
        ? {}
        : pick(recordBase(draft?.base, live, derived.patch), Object.keys(derived.patch));
    const baseVersion =
      op === 'create' ? null : (draft?.base_version ?? (live!['version'] as number));
    const labelRow = op === 'create' ? derived.patch : { ...live!, ...derived.patch };
    ops.push(put(entry, id, op, stored, derived, base, baseVersion, labelRow, draft));
  }
  if (ops.length > 0) await writeDrafts(sb, auth, ops, target(config));
  audit({
    action: `${config.entity}.draft_save`,
    entityType: config.entity,
    detail: { op: 'reorder', count: items.length },
  });
  return {
    reordered: items.length,
    staged: ops.filter((o) => o.action === 'put').length,
    discarded: ops.filter((o) => o.action === 'discard').length,
  };
}
