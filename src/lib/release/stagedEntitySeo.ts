import type { z } from 'zod';
import type { DraftOp } from '@schemas/release';
import type { AdminRouteContext } from '@/lib/admin/route';
import { ENTITY_SEO } from '@/lib/admin/entitySeo';
import { DraftConflictError, OptimisticLockError } from '@/lib/admin/errors';
import { derivePatch, dropNoOps, mergePayload, overlayRow, recordBase } from './overlay';
import { registryEntry } from './registry';
import {
  DRAFT_COLUMNS,
  draftFields,
  draftWasPublished,
  loadDraft,
  parseDraft,
  shouldAudit,
  writeDrafts,
  writtenDraft,
  type StoredDraft,
} from './drafts';
import { invalidMeta, pick, put, stagedSelect } from './staged';
import { parseDraftSave } from './stagedSingleton';

// The staged branch of /api/admin/entity-seo (Admin v2 R3b; docs/admin-v2/releases.md §3).
// SERVER ONLY (it reaches the registry). The route stays thin: with releases on for the
// caller's tenant, its GET and PUT hand the request here; the legacy bodies stay as they are.
//
// Entity SEO is keyed by its target (entity_type, entity_id), not by its own id, and a save is a
// full replace. So:
//   • the pending change of an existing row is keyed by the row's id; with no row yet it is a
//     pending create under a Worker-allocated id, found by its target (0038's
//     `content_drafts_one_seo_create` index allows one per target, and a second is BR409);
//   • the payload ALWAYS stores the target (`entityType`, `entityId`), on an edit too: the
//     publish (R4) reads it and refuses a target that differs from its row (R2's note);
//   • the payload is the whole save, never merged with the previous one (a PUT replaces), so
//     the change writes all six meta columns and records a base for each; `fields` names only
//     the ones that differ from live, for the pending list;
//   • the Arabic meta is still required at stage time (`assertBilingual`, as today).

type Row = Record<string, unknown>;
type Ctx = AdminRouteContext<unknown>;
type Lookup = z.infer<typeof ENTITY_SEO.LookupSchema>;
type Write = z.infer<typeof ENTITY_SEO.WriteSchema>;

const entry = () => registryEntry('entity_seo');
const TARGET = { entity: ENTITY_SEO.entity, cap: ENTITY_SEO.writeCap } as const;

/** GET's answer when the target has no SEO row yet (as the legacy GET says). */
const fallbackOf = (lookup: Lookup): Row => ({
  ...ENTITY_SEO.DEFAULTS,
  entity_type: lookup.entityType,
  entity_id: lookup.entityId,
  id: null,
});

async function readLive(ctx: Ctx, lookup: Lookup): Promise<Row | null> {
  const { data, error } = await ctx.sb
    .from(ENTITY_SEO.table)
    .select(stagedSelect(entry(), ENTITY_SEO.COLUMNS))
    .eq('tenant_id', ctx.auth.tenantId)
    .eq('entity_type', lookup.entityType)
    .eq('entity_id', lookup.entityId)
    .maybeSingle();
  if (error) throw new Error(`read entity_seo: ${error.message}`);
  return (data as Row | null) ?? null;
}

/** The pending change of the target: by the row's id, or the pending create naming it. */
async function loadSeoDraft(ctx: Ctx, live: Row | null, lookup: Lookup) {
  const { sb, auth } = ctx;
  if (live) return loadDraft(sb, auth, 'entity_seo', String(live['id']));
  const { data, error } = await sb
    .from('content_drafts')
    .select(DRAFT_COLUMNS)
    .eq('tenant_id', auth.tenantId)
    .eq('entity_type', 'entity_seo')
    .eq('op', 'create')
    .eq('payload->>entityType', lookup.entityType)
    .eq('payload->>entityId', lookup.entityId)
    .maybeSingle();
  if (error) throw new Error(`load draft: ${error.message}`);
  return data ? parseDraft(data) : null;
}

/** GET: the target's meta, live with its pending change laid over it. */
export async function stagedEntitySeoRead(ctx: Ctx, lookup: Lookup): Promise<Row> {
  const live = await readLive(ctx, lookup);
  const draft = await loadSeoDraft(ctx, live, lookup);
  if (!draft) return { ...(live ?? fallbackOf(lookup)), draft: null };
  try {
    const { row, draft: meta } = overlayRow(live, draft, entry());
    if (!row) return { ...fallbackOf(lookup), draft: meta };
    return live ? { ...row, draft: meta } : { ...fallbackOf(lookup), ...row, draft: meta };
  } catch {
    return { ...(live ?? fallbackOf(lookup)), draft: invalidMeta(draft) };
  }
}

/** PUT: the save becomes the target's pending change (a full replace). */
export async function stagedEntitySeoWrite(ctx: Ctx, raw: unknown): Promise<Row> {
  const { auth, sb, audit } = ctx;
  const { payload, ref } = parseDraftSave<Write>(ENTITY_SEO.WriteSchema, raw);
  ENTITY_SEO.assertBilingual(payload);
  const lookup: Lookup = { entityType: payload.entityType, entityId: payload.entityId };
  const live = await readLive(ctx, lookup);
  const draft: StoredDraft | null = await loadSeoDraft(ctx, live, lookup);

  if (draft) {
    if (draft.release_id !== null) throw new DraftConflictError('scheduled', ENTITY_SEO.entity);
    if (!ref || ref.draftId !== draft.id || ref.draftVersion !== draft.version) {
      throw new DraftConflictError('draft-conflict', ENTITY_SEO.entity);
    }
    if (draft.op === 'delete') {
      throw new DraftConflictError(
        'draft-conflict',
        ENTITY_SEO.entity,
        null,
        'This item is being removed. Undo the removal first.',
      );
    }
  } else if (ref) {
    const published = await draftWasPublished(sb, auth, ref.draftId);
    throw new DraftConflictError(
      published ? 'draft-published' : 'draft-discarded',
      ENTITY_SEO.entity,
      live ?? fallbackOf(lookup),
    );
  } else if (live) {
    if (payload.version !== live['version']) throw new OptimisticLockError(ENTITY_SEO.table);
  } else if (payload.version !== 0 && payload.version !== 1) {
    // What GET reported for a target with no row yet (the legacy first save's rule).
    throw new OptimisticLockError(ENTITY_SEO.table);
  }

  const e = entry();
  const op: DraftOp = live ? 'update' : 'create';
  // A full replace: the save alone, its target always kept.
  const stored = mergePayload(null, payload, e);
  const derived = derivePatch(e, op, stored);
  let changed = derived.patch;
  if (op === 'update') {
    const remaining = dropNoOps(derived.patch, live!, draft?.base);
    if (!remaining) {
      // The save equals live: nothing is pending.
      if (draft) {
        await writeDrafts(
          sb,
          auth,
          [{ action: 'discard', draft_id: draft.id, expected_version: draft.version }],
          TARGET,
        );
        audit({
          action: 'entity_seo.draft_discard',
          entityType: ENTITY_SEO.entity,
          entityId: payload.entityId,
          detail: { op: draft.op, reason: 'no-op', target: payload.entityType },
        });
      }
      return { ...live!, draft: null };
    }
    changed = remaining;
  }

  const entityId = live ? String(live['id']) : (draft?.entity_id ?? crypto.randomUUID());
  const base =
    op === 'create'
      ? {}
      : pick(recordBase(draft?.base, live, derived.patch), Object.keys(derived.patch));
  const baseVersion =
    op === 'create' ? null : (draft?.base_version ?? (live!['version'] as number));
  const labelRow = { ...(live ?? {}), ...derived.patch, entity_type: payload.entityType };
  const write = {
    ...put(e, entityId, op, stored, derived, base, baseVersion, labelRow, draft),
    fields: draftFields({ patch: changed, children: {}, exempt: {} }),
  };
  const [written] = await writeDrafts(sb, auth, [write], TARGET);
  const { row, draft: meta } = overlayRow(live, writtenDraft(write, written!, auth, draft), e);
  if (shouldAudit(draft, auth, op)) {
    audit({
      action: 'entity_seo.draft_save',
      entityType: ENTITY_SEO.entity,
      entityId: payload.entityId,
      detail: { op, fields: write.fields, target: payload.entityType },
    });
  }
  return live ? { ...row, draft: meta } : { ...fallbackOf(lookup), ...row, draft: meta };
}
