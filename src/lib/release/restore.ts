import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  RELEASE_MAX_ITEMS,
  RESTORE_SCAN_MAX,
  type HistoryRestoreRequest,
  type RestoreItem,
  type RestoreResult,
  type RestoreVersionRequest,
} from '@schemas/release';
import type { AuthContext } from '@/lib/auth/types';
import { json, type AdminRouteContext } from '@/lib/admin/route';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { writeSystemLog } from '@/lib/data/systemLog';
import { serviceClient } from '@/lib/supabase/server';
import { AuthorizationError } from '@/lib/authz/errors';
import { mayRead, STAGE_ANY_CAP } from './draftEndpoints';
import { writeDrafts } from './drafts';
import { RELEASE_REGISTRY } from './registry';
import { asOfTargets, readAsOf } from './asOf';
import { planRestore, type PlannedChange, type RestorePlan } from './revert';

// Restoring a version (Admin v2 R10; releases.md A3-8, §6.2, §7 "Restore confirm", §8 edge cases
// 5, 14, 23). SERVER ONLY. A restore never writes the live site: it stages the state at a version
// as pending changes, which are previewed and then published like any other, through the same
// publish path (R6), the same apply (R4) and its guard (R5). Published together they are a
// rollback naming the version (`kind: 'rollback'`, endpoints.ts).
//
//   POST /api/admin/releases/[id]/restore   {pageId?}  the whole site at that version, or one
//                                           page and its sections (the page editor's restore)
//   POST /api/admin/history/restore         {entityType, entityId, seq}  one entity as one of its
//                                           numbered snapshots was
//
// In order: releases on (else 409 `releases-off`); the version (published, the caller's tenant,
// else 404); the state at it (one call, `public.release_as_of`); the plan against live
// (revert.ts), refused whole, with every entity named, when one has a pending change (409
// `pending-changes`), when the person cannot publish one of the changes (403 `forbidden`, with
// who could: Admin and the publishers only, P-2), or when one cannot come back as it was (422
// `not-restorable`: an image today's schema refuses, a link to something gone, an address
// another item now holds); more than one release can carry (60, P-15) is 422 `too-many`; the
// person re-read live; then one `write_drafts` call under their own RLS (the drafts' policies
// and the draft lock bind as for any save), and the restore's mark on those drafts
// (`origin_kind`, `origin_release_id`) by the service role, which the draft lock lets no staff
// token write and which keeps the person as the changes' author (0104). The per-item restore
// also needs the entity's area read, as its history does. Audit `versions.restore` or
// `<type>.history_restore`: ids, counts and types, never a value.

type Ctx<T> = AdminRouteContext<T>;
type Row = Record<string, unknown>;

const Uuid = z.string().uuid();

export const RESTORE_COPY = {
  off: 'Publishing is switched off, so there are no versions to restore.',
  missing: "That version doesn't exist.",
  notVersion: 'Only a published version can be restored.',
  tooFar: (total: number) =>
    `This version is ${total} changes away from the live site. Restore a more recent version first.`,
  tooMany: (count: number) =>
    `Restoring this version would stage ${count} changes, more than one release can publish (${RELEASE_MAX_ITEMS}). Restore a more recent version first.`,
  pending:
    'Some of what this version changes has unpublished changes. Publish or discard them first.',
  forbidden: 'This version includes changes your role can’t publish. Ask an Admin.',
  notRestorable: "Some of this version can't come back as it was.",
  noSnapshot: "That saved version doesn't exist.",
  noHistory: 'History isn’t kept for team members yet.',
} as const;

/** A refusal of the whole restore, every entity named. */
function refusal(plan: RestorePlan): Response | null {
  const of = (reason: RestoreItem['reason']) => plan.refused.filter((r) => r.reason === reason);
  if (of('pending').length > 0) {
    return json(
      { ok: false, error: 'pending-changes', detail: RESTORE_COPY.pending, items: of('pending') },
      409,
    );
  }
  if (of('forbidden').length > 0) {
    return json(
      { ok: false, error: 'forbidden', detail: RESTORE_COPY.forbidden, items: of('forbidden') },
      403,
    );
  }
  if (plan.refused.length > 0) {
    return json(
      {
        ok: false,
        error: 'not-restorable',
        detail: RESTORE_COPY.notRestorable,
        items: plan.refused,
      },
      422,
    );
  }
  if (plan.changes.length > RELEASE_MAX_ITEMS) {
    return json(
      {
        ok: false,
        error: 'too-many',
        detail: RESTORE_COPY.tooMany(plan.changes.length),
        count: plan.changes.length,
      },
      422,
    );
  }
  return null;
}

/**
 * The plan's changes as new pending changes (one writer call, the person's RLS), then marked as
 * a restore of `origin` by the service role. A draft the restore just wrote is at version 1; the
 * mark lands it on 2 (the draft lock), and the answer names each draft at the version it holds.
 * A mark that does not land (a co-author touched the draft in between, a dropped call) leaves an
 * ordinary pending change: logged, `marked: false`, never a failed restore.
 */
async function stage(
  sb: SupabaseClient,
  auth: AuthContext,
  changes: readonly PlannedChange[],
  origin: string | null,
): Promise<{ staged: RestoreResult['staged']; marked: boolean }> {
  const written = await writeDrafts(
    sb,
    auth,
    changes.map((c) => c.write),
    { entity: 'content_draft', cap: STAGE_ANY_CAP[0]! },
  );
  const byEntity = new Map(written.map((w) => [`${w.entity_type}:${w.entity_id}`, w]));
  const versions = new Map(written.map((w) => [w.draft_id, w.version ?? 1]));
  let marked = false;
  try {
    const { data, error } = await serviceClient()
      .from('content_drafts')
      .update({ origin_kind: 'restore', origin_release_id: origin })
      .eq('tenant_id', auth.tenantId)
      .in(
        'id',
        written.map((w) => w.draft_id),
      )
      .eq('version', 1)
      .is('origin_kind', null)
      .select('id,version');
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Row[])
      versions.set(String(row['id']), Number(row['version']));
    marked = Array.isArray(data) && data.length === written.length;
  } catch (err) {
    void writeSystemLog({
      level: 'warn',
      source: 'release:restore',
      message: err instanceof Error ? err.message : 'the restore could not be marked',
      detail: { count: written.length },
    });
  }
  if (!marked) {
    void writeSystemLog({
      level: 'warn',
      source: 'release:restore',
      message: 'Restored changes were staged but not all marked as a restore.',
      detail: { count: written.length },
    });
  }
  return {
    marked,
    staged: changes.map((c) => {
      const w = byEntity.get(`${c.entry.entityType}:${c.entityId}`)!;
      return {
        draftId: w.draft_id,
        draftVersion: versions.get(w.draft_id) ?? 1,
        entityType: c.entry.entityType,
        entityId: c.entityId,
        op: c.op,
        label: c.label,
      };
    }),
  };
}

/** The types a restore touched, for the audit row (never a value). */
const typesOf = (changes: readonly PlannedChange[]) =>
  [...new Set(changes.map((c) => c.entry.entityType))].sort();

/** `POST /api/admin/releases/[id]/restore`. */
export async function restoreVersion(ctx: Ctx<RestoreVersionRequest>): Promise<unknown> {
  const { sb, auth, input, params } = ctx;
  const id = Uuid.safeParse(params['id']);
  if (!id.success)
    return json({ ok: false, error: 'not-found', detail: RESTORE_COPY.missing }, 404);
  if (!(await ctx.releasesEnabled())) {
    return json({ ok: false, error: 'releases-off', detail: RESTORE_COPY.off }, 409);
  }
  const { data, error } = await sb
    .from('content_releases')
    .select('id,number,status')
    .eq('tenant_id', auth.tenantId)
    .eq('id', id.data)
    .maybeSingle();
  if (error) throw new Error(`read version: ${error.message}`);
  const release = data as Row | null;
  if (!release) return json({ ok: false, error: 'not-found', detail: RESTORE_COPY.missing }, 404);
  if (release['status'] !== 'published' || typeof release['number'] !== 'number') {
    return json({ ok: false, error: 'validation', detail: RESTORE_COPY.notVersion }, 422);
  }
  const number = release['number'];

  const state = await readAsOf(sb, auth, number, { limit: RESTORE_SCAN_MAX, pageId: input.pageId });
  if (!state) return json({ ok: false, error: 'not-found', detail: RESTORE_COPY.missing }, 404);
  if (state.total > RESTORE_SCAN_MAX) {
    return json(
      {
        ok: false,
        error: 'too-many',
        detail: RESTORE_COPY.tooFar(state.total),
        count: state.total,
      },
      422,
    );
  }
  const plan = await planRestore(sb, auth, asOfTargets(state.entities));
  const refused = refusal(plan);
  if (refused) return refused;
  const scope = input.pageId ? 'page' : 'site';
  if (plan.changes.length === 0) {
    return { release: { id: id.data, number }, scope, staged: [], kept: plan.kept, marked: true };
  }
  // Staging a restore is the first step of publishing one: the person, re-read now.
  await liveRecheck(auth);
  const { staged, marked } = await stage(sb, auth, plan.changes, id.data);
  ctx.audit({
    action: 'versions.restore',
    entityType: 'release',
    entityId: id.data,
    detail: {
      number,
      scope,
      ...(input.pageId ? { pageId: input.pageId } : {}),
      count: staged.length,
      types: typesOf(plan.changes),
      kept: plan.kept.length,
    },
  });
  return {
    release: { id: id.data, number },
    scope,
    staged,
    kept: plan.kept,
    marked,
  } satisfies RestoreResult;
}

/** `POST /api/admin/history/restore`. */
export async function restoreSnapshot(ctx: Ctx<HistoryRestoreRequest>): Promise<unknown> {
  const { sb, auth, input } = ctx;
  if (!(await ctx.releasesEnabled())) {
    return json({ ok: false, error: 'releases-off', detail: RESTORE_COPY.off }, 409);
  }
  const entry = RELEASE_REGISTRY[input.entityType];
  // Its history is read only by who reads its area (the history route's own rule).
  if (!mayRead(auth.role, entry)) {
    throw new AuthorizationError(entry.readCaps.join('|'), `history of ${entry.entityType}`);
  }
  if (entry.entityType === 'team_member') {
    return json({ ok: false, error: 'validation', detail: RESTORE_COPY.noHistory }, 422);
  }
  const { data, error } = await sb
    .from('content_versions')
    .select('seq,snapshot,release_id')
    .eq('tenant_id', auth.tenantId)
    .eq('entity_type', entry.entityType)
    .eq('entity_id', input.entityId)
    .eq('seq', input.seq)
    .maybeSingle();
  if (error) throw new Error(`read history: ${error.message}`);
  const snapshot = data as Row | null;
  const image = snapshot?.['snapshot'];
  if (!snapshot || !image || typeof image !== 'object' || Array.isArray(image)) {
    return json({ ok: false, error: 'not-found', detail: RESTORE_COPY.noSnapshot }, 404);
  }
  // A snapshot keeps the row (a case study's link sets are not in it: they stay as they are).
  const plan = await planRestore(sb, auth, [
    { entry, entityId: input.entityId, before: image as Row, existsNow: true },
  ]);
  const refused = refusal(plan);
  if (refused) return refused;
  // The version that wrote the snapshot, named in the answer and the audit row. The staged change
  // is marked a restore with no version: one item restored is a publish, not a rollback of the
  // version it came from (a rollback names its version only for a whole restore).
  const origin = typeof snapshot['release_id'] === 'string' ? snapshot['release_id'] : null;
  const number = origin ? await numberOf(sb, auth, origin) : null;
  const release = origin && number ? { id: origin, number } : null;
  if (plan.changes.length === 0) {
    return { release, scope: 'item', staged: [], kept: plan.kept, marked: true };
  }
  await liveRecheck(auth);
  const { staged, marked } = await stage(sb, auth, plan.changes, null);
  ctx.audit({
    action: `${entry.entityType}.history_restore`,
    entityType: entry.entityType,
    entityId: input.entityId,
    detail: { seq: input.seq, ...(number ? { number } : {}), op: plan.changes[0]!.op },
  });
  return { release, scope: 'item', staged, kept: plan.kept, marked } satisfies RestoreResult;
}

async function numberOf(sb: SupabaseClient, auth: AuthContext, id: string): Promise<number | null> {
  const { data, error } = await sb
    .from('content_releases')
    .select('number')
    .eq('tenant_id', auth.tenantId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`read version: ${error.message}`);
  const n = (data as Row | null)?.['number'];
  return typeof n === 'number' ? n : null;
}
