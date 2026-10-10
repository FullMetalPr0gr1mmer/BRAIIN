import { AdminPrefsPutSchema } from '@schemas/adminPrefs';
import { readMyPrefs, saveMyNotificationPrefs } from '@/lib/admin/prefs';
import { defineAdminRoute } from '@/lib/admin/route';

// GET/PUT /api/admin/me/preferences: the signed-in person's own preferences (Admin v2 F8;
// the row is `admin_user_prefs`, 0044, self only in RLS behind a live check). Any member.
// PUT carries the row's version (0 before the first save) and answers 409 when another
// tab saved first. The bell's settings screen (U11) and the dashboard layout (U1) write
// here; a preference can mute what a role sees, never add to it. Not audited: nothing
// here changes what anyone may see or do.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'analytics.read',
  handler: async ({ auth, sb }) => readMyPrefs(sb, auth),
});

export const PUT = defineAdminRoute({
  cap: 'analytics.read',
  input: AdminPrefsPutSchema,
  handler: async ({ auth, sb, input }) =>
    saveMyNotificationPrefs(sb, auth, input.version, input.notifications),
});
