import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { derivePatch } from './overlay';
import { loadDraftsOf, type StoredDraft } from './drafts';
import { registryByTable, type RegistryEntry } from './registry';
import { layeredDb, liveDb, type LayerChange, type OverlayDb, type TableLayer } from './overlayDb';

// Pending changes as layers of the overlay-aware database (Admin v2 R6). SERVER ONLY: it reads
// the registry, which imports every resource config.

/** One stored change as a layer entry; null when its payload no longer parses (left out). */
export function changeOf(
  entry: RegistryEntry,
  draft: StoredDraft,
  tenantId: string,
): LayerChange | null {
  if (draft.op === 'delete') return { op: 'delete' };
  try {
    const { patch } = derivePatch(entry, draft.op, draft.payload);
    if (draft.op === 'update') return { op: 'update', patch };
    return { op: 'create', row: { ...patch, [entry.key]: draft.entity_id, tenant_id: tenantId } };
  } catch {
    return null;
  }
}

/** The key a table's rows are laid over by: `tenant_id` for the singletons, else `id`. */
export const keyOfTable = (table: string): string => registryByTable(table)?.key ?? 'id';

/**
 * Live with EVERY pending change of the tenant laid over it, loaded per table on first need
 * (one read of that type's drafts, at most 1,000, the list overlay's cap): the database a staged
 * save's rules see (R3a's decision D5, now over the pending state). `exists` asks live first,
 * so a save linking to a live row reads no drafts. A table outside the registry is live's.
 *
 * `saving` is the item the save replaces the pending change of: its own draft is left out of
 * the layer, so the rules judge the new version against everything else, never against its own
 * earlier version (a pending create carries no key in the merged row, so a rule could not tell
 * it from another item: swapping `/old-a -> /old-b` to `/old-b -> /old-a` read as a loop).
 */
export function pendingDb(
  sb: SupabaseClient,
  auth: AuthContext,
  saving?: { table: string; id: string },
): OverlayDb {
  const cache = new Map<string, Promise<TableLayer | null>>();
  const load = async (table: string): Promise<TableLayer | null> => {
    const entry = registryByTable(table);
    if (!entry) return null;
    const { drafts } = await loadDraftsOf(sb, auth, entry.entityType);
    const layer = new Map<string, LayerChange>();
    for (const draft of drafts) {
      if (saving && saving.table === table && draft.entity_id === saving.id) continue;
      const change = changeOf(entry, draft, auth.tenantId);
      if (change) layer.set(draft.entity_id, change);
    }
    return layer;
  };
  return layeredDb(
    liveDb(sb, auth),
    (table) => {
      let hit = cache.get(table);
      if (!hit) {
        hit = load(table);
        cache.set(table, hit);
      }
      return hit;
    },
    { keyOf: keyOfTable, existsLiveFirst: true },
  );
}

/** A selection's changes, grouped by table (the layers a publish is judged over). */
export function selectionLayers(
  changes: readonly { entry: RegistryEntry; entityId: string; change: LayerChange }[],
): Map<string, Map<string, LayerChange>> {
  const out = new Map<string, Map<string, LayerChange>>();
  for (const { entry, entityId, change } of changes) {
    let layer = out.get(entry.table);
    if (!layer) {
      layer = new Map();
      out.set(entry.table, layer);
    }
    layer.set(entityId, change);
  }
  return out;
}
