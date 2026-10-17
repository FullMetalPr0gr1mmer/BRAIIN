import { defineAdminRoute } from '@/lib/admin/route';
import { syncVisibilityToEdge } from '@/lib/admin/visibilitySync';

// "Sync to edge" for page visibility (`maintenance.manage`, Admin + Developer; Admin v2
// U14a). Every save already rebuilds the snapshot; this is the same function run by hand:
// the first snapshot after a deploy (launch runbook §6j), a retry after `kvSynced: false`.
// The redirects precedent (src/pages/api/admin/redirects/sync.ts): the table is the source
// of truth, KV is what the middleware reads, and the answer says whether they agree.

export const prerender = false;

export const POST = defineAdminRoute({
  cap: 'maintenance.manage',
  handler: async ({ auth, sb, audit }) => {
    const result = await syncVisibilityToEdge(sb, auth);
    audit({ action: 'page_visibility.sync', entityType: 'page_visibility', detail: { ...result } });
    return result;
  },
});
