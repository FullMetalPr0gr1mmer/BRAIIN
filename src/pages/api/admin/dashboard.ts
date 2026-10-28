import { PUBLIC_SITE_URL } from 'astro:env/client';
import { CMS_ROLES } from '@/lib/auth/types';
import { withoutWidgets } from '@/lib/admin/dashboard/layout';
import { loadDashboard } from '@/lib/admin/dashboard/loaders';
import { RELEASE_WIDGETS } from '@/lib/admin/dashboard/widgets';
import { defineAdminRoute } from '@/lib/admin/route';

// GET /api/admin/dashboard: the dashboard's JSON twin (Admin v2 U1). The same loaders as
// /admin (src/lib/admin/dashboard/loaders.ts): the person's resolved layout (theirs, else
// their role's preset, else the code's default) and the data of each widget it shows, each
// loaded only when the role's capabilities show it, through the caller's RLS-bound client.
// analytics.read, which all four roles hold; what each SEES is the registry's and RLS's: a
// Content Creator gets no lead or application figure, not even a count. A widget whose read
// failed comes back `{ ok: false }` (logged), never as an error for the whole dashboard.
//
// Admin v2 R13: as on /admin, the release widgets (the publish card) leave the layout while
// releases are off for the tenant, or the flag cannot be read (review R13-C6). The flag is
// asked for a CMS role only, as the page asks it; no other role is offered the card.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'analytics.read',
  handler: async (ctx) => {
    const { auth, sb } = ctx;
    const readsReleases = (CMS_ROLES as readonly string[]).includes(auth.role);
    const [dashboard, releases] = await Promise.all([
      loadDashboard({ sb, auth, now: new Date(), siteUrl: PUBLIC_SITE_URL }),
      readsReleases ? ctx.releasesEnabled().catch(() => false) : Promise.resolve(false),
    ]);
    const widgets = releases
      ? dashboard.widgets
      : Object.fromEntries(
          Object.entries(dashboard.widgets).filter(
            ([id]) => !(RELEASE_WIDGETS as readonly string[]).includes(id),
          ),
        );
    return {
      role: auth.role,
      layout: releases ? dashboard.layout : withoutWidgets(dashboard.layout, RELEASE_WIDGETS),
      source: dashboard.source,
      widgets,
      banners: dashboard.banners,
    };
  },
});
