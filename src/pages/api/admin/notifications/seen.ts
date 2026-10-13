import { NotificationsSeenSchema } from '@schemas/adminPrefs';
import { defineAdminRoute } from '@/lib/admin/route';
import { markNotificationsSeen, seenUpTo } from '@/lib/admin/prefs';

// POST /api/admin/notifications/seen: "Mark all as read" (Admin v2 F8). Moves the signed-in
// person's watermark to `asOf`, the moment the list the drawer showed was read (the feed's
// own `asOf`), held to now: an item that arrived after the list loaded was never shown, so
// it stays unread. The database keeps the watermark moving forward only and never past its
// own clock (0044). Any member, their own row only.

export const prerender = false;

export const POST = defineAdminRoute({
  cap: 'analytics.read',
  input: NotificationsSeenSchema,
  handler: async ({ auth, sb, input }) => ({
    seenAt: await markNotificationsSeen(sb, auth, seenUpTo(input.asOf)),
  }),
});
