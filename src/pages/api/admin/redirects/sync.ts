import { defineAdminRoute } from '@/lib/admin/route';
import { edgeRedirectCount, syncRedirectsToEdge } from '@/lib/admin/redirectSync';

// The edge snapshot by hand (`redirects.manage` — Admin + SEO). Every save and delete
// already rebuilds it (redirectResource's hooks); this exists for the first snapshot
// after a deploy (runbook §6f), a retry after `kvSynced: false`, and the status line
// beside the button. Same pattern as settings/maintenance.ts: the table is the source
// of truth, KV is what the middleware reads, and the response says whether they agree.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'redirects.manage',
  handler: async ({ auth, sb }) => {
    const { count, error } = await sb
      .from('redirects')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', auth.tenantId);
    if (error) throw new Error(`count redirects: ${error.message}`);
    return { db: count ?? 0, edge: await edgeRedirectCount() };
  },
});

export const POST = defineAdminRoute({
  cap: 'redirects.manage',
  handler: async ({ auth, sb, audit }) => {
    const result = await syncRedirectsToEdge(sb, auth);
    // A sitewide routing change is audited whether or not the edge took it: a
    // `kvSynced: false` row is how "the redirects were never live" is found later.
    audit({ action: 'redirect.sync', entityType: 'redirect', detail: { ...result } });
    return result;
  },
});
