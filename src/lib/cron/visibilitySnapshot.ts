import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveLaunchTenantId } from '@/lib/data/tenant';
import { rebuildVisibilitySnapshot, restrictedCount } from '@/lib/admin/visibilitySync';

// The daily page-visibility re-sync (Admin v2 U14a): the snapshot KV `site:visibility` holds,
// rebuilt from `page_visibility` as the service role, so a save whose KV write failed (it
// said `kvSynced: false`) is put right by the next morning even if nobody presses "Sync to
// edge". The launch tenant's rows only: the key is the single tenant's, as `site:redirects`
// is. At most five subrequests: the tenant, the rows, the KV write, the rows again and, when
// a save landed in between, the KV write again (rebuildVisibilitySnapshot: KV has no
// compare-and-swap, and a save at the same moment must not be overwritten by an older read).

export interface VisibilitySnapshotRun {
  /** Pages and templates the snapshot restricts. */
  restricted: number;
  /** Whether KV took it. */
  kvSynced: boolean;
}

export async function runVisibilitySnapshot(sb: SupabaseClient): Promise<VisibilitySnapshotRun> {
  const tenantId = await resolveLaunchTenantId();
  if (!tenantId) throw new Error('page visibility re-sync: no launch tenant');
  const { snapshot, kvSynced } = await rebuildVisibilitySnapshot(sb, tenantId);
  return { restricted: restrictedCount(snapshot), kvSynced };
}
