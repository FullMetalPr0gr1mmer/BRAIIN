import { defineAdminRoute } from '@/lib/admin/route';
import { markNotificationsSeen } from '@/lib/admin/prefs';

// POST /api/admin/notifications/seen: "Mark all as read" (Admin v2 F8). Moves the signed-in
// person's watermark to now; the database keeps it moving forward only and never past its
// own clock (0044). Any member, their own row only.

export const prerender = false;

export const POST = defineAdminRoute({
  cap: 'analytics.read',
  handler: async ({ auth, sb }) => ({ seenAt: await markNotificationsSeen(sb, auth) }),
});
