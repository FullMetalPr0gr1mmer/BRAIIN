import { NotificationSettingsPatchSchema } from '@schemas/notificationSettings';
import { OptimisticLockError } from '@/lib/admin/errors';
import { mutedAfter, settingsOf } from '@/lib/admin/notificationSettings';
import { readMyPrefs, saveMyNotificationPrefs } from '@/lib/admin/prefs';
import { defineAdminRoute } from '@/lib/admin/route';

// GET/PATCH /api/admin/me/notification-settings (Admin v2 U11): the bell's settings for the
// signed-in person, one switch per kind of item their role's bell shows (true = on). Any
// member (`analytics.read`, which every role holds), and only their own row: admin_user_prefs
// is self only in RLS behind a live check (0044). A flat shape, so the settings screen saves
// through useEntitySave as a singleton; underneath it is F8's `notifications.muted`, and a
// stored mute of a kind the role cannot see is kept. A kind the role's bell never shows is a
// 422 (a preference quiets, never widens); a stale version is a 409 (the version is the
// whole row's, so a dashboard layout saved in another tab moves it too). Not audited, as
// /api/admin/me/preferences: nothing here changes what anyone may see or do.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'analytics.read',
  handler: async ({ auth, sb }) => settingsOf(await readMyPrefs(sb, auth), auth.role),
});

export const PATCH = defineAdminRoute({
  cap: 'analytics.read',
  input: NotificationSettingsPatchSchema,
  handler: async ({ auth, sb, input }) => {
    const stored = await readMyPrefs(sb, auth);
    const muted = mutedAfter(stored.notifications.muted, input, auth.role);
    // The mutes kept for hidden kinds are read here, so they must be the version the person
    // saved against: anything newer is someone else's save (another tab), a 409.
    if (stored.version !== input.version) throw new OptimisticLockError('admin_user_prefs');
    const saved = await saveMyNotificationPrefs(sb, auth, input.version, { muted });
    return settingsOf(saved, auth.role);
  },
});
