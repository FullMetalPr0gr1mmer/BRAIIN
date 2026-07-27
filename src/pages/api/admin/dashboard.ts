import { defineAdminRoute } from '@/lib/admin/route';
import { can } from '@/lib/authz/matrix';

// Dashboard "needs attention" banners — stale posts, scheduled-for-today, missing cover
// images. Backed by the `dashboard_attention` VIEW (migration 0009), because CLAUDE.md
// §8 says these are derived views rather than a table: a materialised banner table
// would need invalidating on every content write and would be wrong for exactly as long
// as anyone forgot to.
//
// The view is `security_invoker`, so each caller sees only rows their own RLS allows.
// Gated on `analytics.read`, which all four roles hold — but a role with no content
// capabilities gets an empty content section rather than a 403, because an empty
// dashboard is the honest answer for someone with nothing to action.

export const prerender = false;

interface AttentionRow {
  kind: string;
  entity_type: string;
  id: string;
  slug: string;
  title: Record<string, string> | null;
  at: string | null;
}

export const GET = defineAdminRoute({
  cap: 'analytics.read',
  handler: async ({ auth, sb }) => {
    const canSeeContent =
      can(auth.role, 'blog.write') === 'full' ||
      can(auth.role, 'services.write') === 'full' ||
      can(auth.role, 'seo.entityMeta') === 'full';

    const attention: AttentionRow[] = [];
    if (canSeeContent) {
      const { data, error } = await sb
        .from('dashboard_attention')
        .select('kind,entity_type,id,slug,title,at')
        .limit(100);
      if (error) throw new Error(`dashboard: ${error.message}`);
      attention.push(...((data ?? []) as AttentionRow[]));
    }

    const counts: Record<string, number> = {};
    for (const row of attention) counts[row.kind] = (counts[row.kind] ?? 0) + 1;

    // Lead count is a headline number, and it is gated on its own capability rather
    // than on the dashboard's: a Content Creator must not learn how many leads came in
    // this week from a widget when the whole leads section is closed to them.
    let openLeads: number | null = null;
    if (can(auth.role, 'leads.manage') === 'full') {
      const { count } = await sb
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', auth.tenantId)
        .eq('status', 'new');
      openLeads = count ?? 0;
    }

    return { role: auth.role, attention, counts, openLeads };
  },
});
