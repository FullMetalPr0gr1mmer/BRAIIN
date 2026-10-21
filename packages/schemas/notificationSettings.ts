import { z } from 'zod';
import { NOTIFICATION_KINDS, type NotificationKind } from './adminPrefs';

// The bell's settings (Admin v2 U11, /admin/settings/notifications): one switch per kind of
// item, `true` for on. GET and PATCH /api/admin/me/notification-settings speak it; the row is
// F8's admin_user_prefs (`notifications.muted`, the kinds switched off), so a kind left out
// of a PATCH keeps what it had. `version` is the row's (0 before the first save); a stale one
// is a 409. Built from NOTIFICATION_KINDS, so a kind a later slice adds is a switch at once.
// Strict: a key that is no kind is a 422. Which kinds a role may name is the route's to
// decide (src/lib/admin/notificationSettings.ts): one its bell never shows is a 422 too.

const kindSwitches = Object.fromEntries(
  NOTIFICATION_KINDS.map((kind) => [kind, z.boolean().optional()]),
) as Record<NotificationKind, z.ZodOptional<z.ZodBoolean>>;

export const NotificationSettingsPatchSchema = z
  .object({ ...kindSwitches, version: z.number().int().min(0) })
  .strict();
export type NotificationSettingsPatch = z.infer<typeof NotificationSettingsPatchSchema>;

/** What GET and PATCH answer: the version and a switch for each kind the role's bell shows. */
export type NotificationSettings = { version: number } & Partial<Record<NotificationKind, boolean>>;
