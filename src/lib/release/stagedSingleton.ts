import { z } from 'zod';
import { DraftRefFieldsSchema, type DraftOp } from '@schemas/release';
import type { AdminRouteContext } from '@/lib/admin/route';
import type { SingletonConfig } from '@/lib/admin/singleton';
import type { ResourcePayload } from '@/lib/admin/resource';
import { DraftConflictError, OptimisticLockError, ValidationError } from '@/lib/admin/errors';
import { jsonEqual } from './deepEqual';
import { derivePatch, dropNoOps, mergePayload, overlayRow, recordBase } from './overlay';
import { registryByTable, type RegistryEntry } from './registry';
import {
  draftWasPublished,
  dropFields,
  loadDraft,
  shouldAudit,
  writeDrafts,
  writtenDraft,
  type StoredDraft,
} from './drafts';
import { invalidMeta, pick, put, stagedSelect } from './staged';

// The staged branch of the singleton kernel (Admin v2 R3b; docs/admin-v2/releases.md §3): the
// public identity (`site_profile`) and the global SEO defaults (`seo_defaults`), the two
// per-tenant rows in the release registry. SERVER ONLY (it reaches the registry).
//
// With releases on for the caller's tenant, src/lib/admin/singleton.ts hands GET and PATCH here,
// one line at the top of each handler; its legacy bodies stay as they are (R15 removes them).
// The other singletons (site_settings, site_integrations, ai_config) are not in the registry
// and never ask the flag. The rules are the resource kernel's (src/lib/release/staged.ts), keyed
// by the tenant instead of an id:
//   • the pending change's entity id IS the tenant id (0062's `app.draft_key_ok` refuses any
//     other), so there is at most one per tenant;
//   • `guardWrite` still runs first, on the whole save (the job-application switch stays
//     Admin-only in the Worker);
//   • an immediate column (`site_profile.accepting_applications`) is never staged: a save that
//     would change it is 422 (it has its own endpoint, PATCH /api/admin/site-profile/intake),
//     and one that sends it unchanged is let through (the settings form always sends it);
//   • no row yet: the change is a pending create over the config's defaults, as the legacy
//     first save is an INSERT over them. If the row appears while a create is pending (the
//     intake switch inserts one), the change is read, and saved, as an edit of that row.

type Row = Record<string, unknown>;
type Ctx = AdminRouteContext<unknown>;

/** The registry entry a singleton stages through, or undefined (settings, integrations, AI). */
export function singletonEntry(config: SingletonConfig): RegistryEntry | undefined {
  const entry = registryByTable(config.table);
  return entry?.kind === 'singleton' ? entry : undefined;
}

/** What an editor reads about an immediate column's own switch, per column. */
const IMMEDIATE_COPY: Readonly<Record<string, string>> = {
  accepting_applications:
    'Opening or closing job applications happens at once. Use the Job applications switch.',
};

const target = (config: SingletonConfig) => ({ entity: config.entity, cap: config.writeCap });

/** A select list plus names it does not hold yet (singleton lists are plain column names). */
function withColumns(list: string, extra: readonly string[]): string {
  const have = new Set(list.split(',').map((c) => c.trim()));
  const add = extra.filter((c) => c && !have.has(c));
  return add.length > 0 ? `${list},${add.join(',')}` : list;
}

/** The live row: the editor's columns, the guard's, the immediate ones and the allowlist. */
async function readLive(config: SingletonConfig, entry: RegistryEntry, ctx: Ctx) {
  const extra = [
    ...(config.guardColumns ?? '').split(',').map((c) => c.trim()),
    ...entry.immediateColumns,
  ];
  const { data, error } = await ctx.sb
    .from(config.table)
    .select(stagedSelect(entry, withColumns(config.columns, extra)))
    .eq('tenant_id', ctx.auth.tenantId)
    .maybeSingle();
  if (error) throw new Error(`get ${config.table}: ${error.message}`);
  return (data as Row | null) ?? null;
}

/** GET's answer when the row does not exist yet (as the legacy GET says). */
const fallbackOf = (config: SingletonConfig): Row => ({ ...config.defaults, version: 0 });

/**
 * The pending change as it applies to what is live: a create that a row has since appeared
 * under reads as an edit of that row (its base is recorded on the next save).
 */
function overLive(draft: StoredDraft | null, live: Row | null): StoredDraft | null {
  return draft && draft.op === 'create' && live ? { ...draft, op: 'update' } : draft;
}

/**
 * A save's body: the schema's payload and the pending change it names (`draftId` +
 * `draftVersion`, both or neither). With a change named, its version stands in for the
 * schema's required `version` when the form sent none (a pending create has no live version).
 */
export function parseDraftSave<T extends Row>(
  schema: z.ZodTypeAny,
  raw: unknown,
): { payload: T & { version: number }; ref: { draftId: string; draftVersion: number } | null } {
  const body = z.record(z.string(), z.unknown()).parse(raw);
  const { draftId, draftVersion, ...rest } = body;
  const ref = DraftRefFieldsSchema.parse({ draftId, draftVersion });
  const named = ref.draftId !== undefined && ref.draftVersion !== undefined;
  const payload = schema.parse(
    named && (rest['version'] === undefined || rest['version'] === 0)
      ? { ...rest, version: ref.draftVersion }
      : rest,
  ) as T & { version: number };
  return {
    payload,
    ref: named ? { draftId: ref.draftId!, draftVersion: ref.draftVersion! } : null,
  };
}

/** GET: live (or the defaults) with the tenant's pending change laid over it. */
export async function stagedSingletonRead(
  config: SingletonConfig,
  entry: RegistryEntry,
  ctx: Ctx,
): Promise<Row> {
  const [live, stored] = await Promise.all([
    readLive(config, entry, ctx),
    loadDraft(ctx.sb, ctx.auth, entry.entityType, ctx.auth.tenantId),
  ]);
  const draft = overLive(stored, live);
  if (!draft) return { ...(live ?? fallbackOf(config)), draft: null };
  try {
    const { row, draft: meta } = overlayRow(live, draft, entry);
    if (!row) return { ...fallbackOf(config), draft: meta };
    // A pending create has only what it writes: the defaults fill the rest (the immediate
    // switch included), as the INSERT that publishes it will.
    return live ? { ...row, draft: meta } : { ...fallbackOf(config), ...row, draft: meta };
  } catch {
    // A payload that no longer parses: show live, and say so (R6's dry run reports it).
    return { ...(live ?? fallbackOf(config)), draft: invalidMeta(draft) };
  }
}

/** PATCH: merge the save into the tenant's pending change (or start one). */
export async function stagedSingletonUpdate(
  config: SingletonConfig,
  entry: RegistryEntry,
  ctx: Ctx,
  raw: unknown,
): Promise<Row> {
  const { auth, sb, audit } = ctx;
  const { payload, ref } = parseDraftSave<ResourcePayload>(config.schema, raw);
  const values = config.toRow(payload);

  const [live, stored] = await Promise.all([
    readLive(config, entry, ctx),
    loadDraft(sb, auth, entry.entityType, auth.tenantId),
  ]);
  // The Worker layer of a rule narrower than the row, on the whole save, before anything else.
  config.guardWrite?.(auth, live, values);
  for (const column of entry.immediateColumns) {
    if (!(column in values)) continue;
    const now = live ? live[column] : config.defaults[column];
    if (!jsonEqual(values[column] ?? null, now ?? null)) {
      const key = Object.entries(entry.fields).find(([, cols]) => cols.includes(column))?.[0];
      throw new ValidationError(
        IMMEDIATE_COPY[column] ?? 'This setting changes at once. Use its own switch.',
        key ?? column,
      );
    }
  }

  const draft = overLive(stored, live);
  if (draft) {
    if (draft.release_id !== null) throw new DraftConflictError('scheduled', config.entity);
    if (!ref || ref.draftId !== draft.id || ref.draftVersion !== draft.version) {
      throw new DraftConflictError('draft-conflict', config.entity);
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
    const published = await draftWasPublished(sb, auth, ref.draftId);
    throw new DraftConflictError(
      published ? 'draft-published' : 'draft-discarded',
      config.entity,
      live ?? fallbackOf(config),
    );
  } else if (live) {
    if (payload.version !== live['version']) throw new OptimisticLockError(config.table);
  } else if (payload.version !== 0 && payload.version !== 1) {
    // What GET reported for the row that does not exist yet (the legacy first save's rule).
    throw new OptimisticLockError(config.table);
  }

  const op: DraftOp = live ? 'update' : 'create';
  let merged = mergePayload(draft?.payload, payload, entry);
  let derived = derivePatch(entry, op, merged);
  if (op === 'update') {
    const remaining = dropNoOps(derived.patch, live!, draft?.base);
    merged = dropFields(entry, merged, Object.keys(remaining ?? {}));
  }
  if (Object.keys(merged).length === 0) {
    // Nothing differs from live (or, with no row, nothing was given): no pending change.
    if (stored) {
      await writeDrafts(
        sb,
        auth,
        [{ action: 'discard', draft_id: stored.id, expected_version: stored.version }],
        target(config),
      );
      audit({
        action: `${config.entity}.draft_discard`,
        entityType: config.entity,
        entityId: auth.tenantId,
        detail: { op: stored.op, reason: 'no-op' },
      });
    }
    return { ...(live ?? fallbackOf(config)), draft: null };
  }
  if (op === 'update') derived = derivePatch(entry, 'update', merged);

  const base =
    op === 'create'
      ? {}
      : pick(recordBase(draft?.base, live, derived.patch), Object.keys(derived.patch));
  const baseVersion =
    op === 'create' ? null : (draft?.base_version ?? (live!['version'] as number));
  const labelRow = live ? { ...live, ...derived.patch } : derived.patch;
  const write = put(entry, auth.tenantId, op, merged, derived, base, baseVersion, labelRow, stored);
  const [written] = await writeDrafts(sb, auth, [write], target(config));
  const { row, draft: meta } = overlayRow(live, writtenDraft(write, written!, auth, stored), entry);
  if (shouldAudit(stored, auth, op)) {
    audit({
      action: `${config.entity}.draft_save`,
      entityType: config.entity,
      entityId: auth.tenantId,
      detail: { op, fields: meta.fields },
    });
  }
  return live ? { ...row, draft: meta } : { ...fallbackOf(config), ...row, draft: meta };
}
