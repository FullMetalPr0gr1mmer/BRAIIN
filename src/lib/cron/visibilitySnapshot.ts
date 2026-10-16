import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from 'cloudflare:workers';
import { putVisibilitySnapshot } from '@/lib/http/visibility';
import { resolveLaunchTenantId } from '@/lib/data/tenant';
import {
  buildVisibilitySnapshot,
  readVisibilityRows,
  restrictedCount,
} from '@/lib/admin/visibilitySync';

// The daily page-visibility re-sync (Admin v2 U14a): the snapshot KV `site:visibility` holds,
// rebuilt from `page_visibility` as the service role, so a save whose KV write failed (it
// said `kvSynced: false`) is put right by the next morning even if nobody presses "Sync to
// edge". The launch tenant's rows only: the key is the single tenant's, as `site:redirects`
// is. Three subrequests: the tenant, the rows, the KV write.

export interface VisibilitySnapshotRun {
  /** Pages and templates the snapshot restricts. */
  restricted: number;
  /** Whether KV took it. */
  kvSynced: boolean;
}

export async function runVisibilitySnapshot(sb: SupabaseClient): Promise<VisibilitySnapshotRun> {
  const tenantId = await resolveLaunchTenantId();
  if (!tenantId) throw new Error('page visibility re-sync: no launch tenant');
  const snapshot = buildVisibilitySnapshot(await readVisibilityRows(sb, tenantId));
  const kvSynced = await putVisibilitySnapshot(env, snapshot);
  return { restricted: restrictedCount(snapshot), kvSynced };
}
