import { env } from 'cloudflare:workers';
import { defineAdminRoute } from '@/lib/admin/route';
import { loadNotifications } from '@/lib/admin/notifications';
import { getMaintenanceState } from '@/lib/http/maintenance';

// GET /api/admin/notifications: the bell's list, at most 30 items, for the signed-in
// person (Admin v2 F8, docs/admin-v2/ui.md §2.8). Any member; WHICH items is decided per
// source from ROLE_CAPS (src/lib/admin/notifications), and the caller's RLS decides the
// rows again: Content Creator and SEO get no lead or application item, not even a count.
// Asked when the drawer opens, never on a timer (Workers Free plan, P-15).

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'analytics.read',
  handler: async ({ auth, sb, studioTimeZone }) =>
    loadNotifications(sb, auth, {
      maintenance: () => getMaintenanceState(env),
      labels: true,
      tz: await studioTimeZone(),
    }),
});
