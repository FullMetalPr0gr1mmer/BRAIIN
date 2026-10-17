import { PUBLIC_SITE_URL } from 'astro:env/client';
import { loadDashboard } from '@/lib/admin/dashboard/loaders';
import { defineAdminRoute } from '@/lib/admin/route';

// GET /api/admin/dashboard: the dashboard's JSON twin (Admin v2 U1). The same loaders as
// /admin (src/lib/admin/dashboard/loaders.ts): the person's resolved layout (theirs, else
// their role's preset, else the code's default) and the data of each widget it shows, each
// loaded only when the role's capabilities show it, through the caller's RLS-bound client.
// analytics.read, which all four roles hold; what each SEES is the registry's and RLS's: a
// Content Creator gets no lead or application figure, not even a count. A widget whose read
// failed comes back `{ ok: false }` (logged), never as an error for the whole dashboard.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'analytics.read',
  handler: async ({ auth, sb }) => {
    const dashboard = await loadDashboard({ sb, auth, now: new Date(), siteUrl: PUBLIC_SITE_URL });
    return {
      role: auth.role,
      layout: dashboard.layout,
      source: dashboard.source,
      widgets: dashboard.widgets,
      banners: dashboard.banners,
    };
  },
});
