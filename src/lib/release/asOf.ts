import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AsOfAnswerSchema,
  RELEASE_ENTITY_TYPES,
  type AsOfAnswer,
  type AsOfEntity,
  type DraftOp,
  type ReleaseEntityType,
} from '@schemas/release';
import type { AuthContext } from '@/lib/auth/types';
import { RELEASE_REGISTRY, type RegistryEntry } from './registry';
import { childrenPayload, rowToPayload, type LinkSetsImage } from './rowPayload';

// The state at a version (Admin v2 R10; releases.md A3-8, §6.2, slice R10: "the as-of overlay
// … is reused by the preview dataset (?v=n)"). SERVER ONLY.
//
// It comes from the ledger in one call, `public.release_as_of` (0104): for every entity changed
// after vN (by a release or out of band), the image before its earliest such change, which is
// its state at vN (null: it did not exist then), and whether it exists now. Two readers use it:
//   • the preview of a version (`?v=N`, src/lib/preview/dataset.ts): the changes from vN back to
//     now (`asOfChanges`), laid over live in place of the pending changes, through the same
//     overlay, mirror and report as a preview of pending changes;
//   • the restore (revert.ts), which reads each one against live before staging it.
// Team members are never in the ledger (owner item O-12): a version does not hold them, and
// neither reader touches them.

type Row = Record<string, unknown>;
type Payload = Record<string, unknown>;

/** The state at version N for the caller's tenant, or null when there is no such version. */
export async function readAsOf(
  sb: SupabaseClient,
  auth: Pick<AuthContext, 'tenantId'>,
  number: number,
  opts: { limit: number; pageId?: string | undefined },
): Promise<AsOfAnswer | null> {
  const { data, error } = await sb.rpc('release_as_of', {
    p_tenant: auth.tenantId,
    p_number: number,
    p_limit: opts.limit,
    p_page: opts.pageId ?? null,
  });
  if (error) {
    if ((error as { code?: string }).code === 'P0002') return null;
    throw new Error(`release_as_of: ${(error as { code?: string }).code ?? ''} ${error.message}`);
  }
  const parsed = AsOfAnswerSchema.safeParse(data);
  if (!parsed.success) throw new Error('release_as_of answered in the wrong shape');
  return parsed.data;
}

const isRegistryType = (type: string): type is ReleaseEntityType =>
  (RELEASE_ENTITY_TYPES as readonly string[]).includes(type);

/** One registry entity the state at a version differs on. */
export interface AsOfTarget {
  entry: RegistryEntry;
  entityId: string;
  /**
   * Its image at vN: null when it did not exist then; undefined when only its link sets
   * changed since (a case study whose row is as it was).
   */
  before: Row | null | undefined;
  /** Whether the ledger says it exists now (the restore reads live to be sure). */
  existsNow: boolean;
  /** A case study's link sets at vN, when they changed since. */
  children?: LinkSetsImage;
}

/** The ledger's answer as registry entities, a case study's link sets beside its row. */
export function asOfTargets(entities: readonly AsOfEntity[]): AsOfTarget[] {
  const out = new Map<string, AsOfTarget>();
  for (const e of entities) {
    if (!isRegistryType(e.entity_type) || e.entity_type === 'team_member') continue;
    out.set(`${e.entity_type}:${e.entity_id}`, {
      entry: RELEASE_REGISTRY[e.entity_type],
      entityId: e.entity_id,
      before: e.before,
      existsNow: e.exists_now,
    });
  }
  for (const e of entities) {
    if (e.entity_type !== 'portfolio_children') continue;
    const key = `portfolio:${e.entity_id}`;
    const target = out.get(key) ?? {
      entry: RELEASE_REGISTRY.portfolio,
      entityId: e.entity_id,
      before: undefined,
      existsNow: true,
    };
    // No sets then (they began since): both empty, so a restore or a preview clears them.
    target.children = (e.before ?? { service_ids: [], media: [] }) as LinkSetsImage;
    out.set(key, target);
  }
  return [...out.values()];
}

/** One change of a version's preview: what the overlay lays over live. */
export interface AsOfChange {
  entityType: ReleaseEntityType;
  entityId: string;
  op: DraftOp;
  payload: Payload;
}

/**
 * The preview of version N: each entity as it was, from the ledger alone. An edit carries the
 * whole image (the overlay replaces the row's columns); a removal since comes back as a create;
 * a creation since goes. A payload that no longer reads is reported by the dataset like an
 * invalid pending change.
 */
export function asOfChanges(targets: readonly AsOfTarget[]): AsOfChange[] {
  const out: AsOfChange[] = [];
  for (const t of targets) {
    const { entityType } = t.entry;
    if (t.before === undefined) {
      if (t.children) {
        out.push({
          entityType,
          entityId: t.entityId,
          op: 'update',
          payload: childrenPayload(t.children),
        });
      }
      continue;
    }
    if (t.before === null) {
      if (t.existsNow) out.push({ entityType, entityId: t.entityId, op: 'delete', payload: {} });
      continue;
    }
    out.push({
      entityType,
      entityId: t.entityId,
      op: t.existsNow ? 'update' : 'create',
      payload: rowToPayload(t.entry, t.before, t.children),
    });
  }
  return out;
}
