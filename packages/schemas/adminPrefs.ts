import { z } from 'zod';

// The personal layer (Admin v2 F8, docs/admin-v2/ui.md AV-05): what a signed-in person
// changes about themselves. Preferences live in `admin_user_prefs` (0044, self only);
// the name in `profiles.display_name` through `update_my_profile()`; the password in
// Supabase Auth, after re-authentication.

// ── Notifications (the bell) ──────────────────────────────────────────────────────────

/**
 * The kinds of item the bell can carry: one per source in src/lib/admin/notifications
 * (tests/lib/notifications.spec.ts holds the two lists equal). A kind is visible only to
 * the roles its source names; a preference can mute one, never add one.
 */
export const NOTIFICATION_KINDS = ['leads', 'applications', 'scheduled', 'maintenance'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

const isKind = (value: unknown): value is NotificationKind =>
  typeof value === 'string' && (NOTIFICATION_KINDS as readonly string[]).includes(value);

/** What a PUT may set: the muted kinds, each known, each once. */
export const NotificationPrefsSchema = z
  .object({
    muted: z
      .array(z.enum(NOTIFICATION_KINDS))
      .max(NOTIFICATION_KINDS.length)
      .transform((kinds) => [...new Set(kinds)]),
  })
  .strict();
export type NotificationPrefs = { muted: NotificationKind[] };

/**
 * Stored preferences, read leniently: a kind this build does not know (a later slice's,
 * or a removed one) is dropped rather than failing the bell, and anything malformed reads
 * as "nothing muted".
 */
export function readNotificationPrefs(raw: unknown): NotificationPrefs {
  const muted =
    raw && typeof raw === 'object' && Array.isArray((raw as { muted?: unknown }).muted)
      ? (raw as { muted: unknown[] }).muted
      : [];
  return { muted: [...new Set(muted.filter(isKind))] };
}

/**
 * PUT /api/admin/me/preferences. `version` is the row's (0 when there is no row yet), the
 * optimistic lock of CLAUDE.md Pillar 4. The dashboard's layout and quick actions join this
 * schema with the dashboard slice (U1); until then a body naming them is refused.
 */
export const AdminPrefsPutSchema = z
  .object({
    version: z.number().int().min(0),
    notifications: NotificationPrefsSchema,
  })
  .strict();
export type AdminPrefsPut = z.infer<typeof AdminPrefsPutSchema>;

// ── The account ──────────────────────────────────────────────────────────────────────

export const DISPLAY_NAME_MAX = 80;

// Any Unicode control or format character (bidi overrides included): a name is shown
// beside every edit in the activity log, so it must not reorder or hide the text around it.
const CONTROL = /[\p{Cc}\p{Cf}]/u;

/**
 * PATCH /api/admin/me: the caller's display name. Trimmed; empty clears it (the shell
 * then shows the e-mail). The database checks the same rules (update_my_profile, 0044).
 */
export const DisplayNameSchema = z
  .object({
    display_name: z
      .string()
      .trim()
      .max(DISPLAY_NAME_MAX, `Use ${DISPLAY_NAME_MAX} characters or fewer.`)
      .refine((value) => !CONTROL.test(value), 'Use letters, numbers and spaces only.'),
  })
  .strict();
export type DisplayNameInput = z.infer<typeof DisplayNameSchema>;

/** The shortest new password the admin accepts. GoTrue's own policy may ask for more. */
export const PASSWORD_MIN = 10;
/** bcrypt, which GoTrue hashes with, reads 72 bytes and ignores the rest. */
export const PASSWORD_MAX_BYTES = 72;

const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;

/**
 * POST /api/admin/me/password. The current password re-authenticates the person first
 * (a wrong one counts toward the sign-in lockout); the new one is typed twice.
 */
export const PasswordChangeSchema = z
  .object({
    current: z.string().min(1, 'Enter your current password.').max(256),
    next: z
      .string()
      .min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters.`)
      .refine(
        (value) => utf8Bytes(value) <= PASSWORD_MAX_BYTES,
        'That password is too long. Try a shorter one.',
      ),
    confirm: z.string(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.confirm !== value.next) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confirm'],
        message: 'The two new passwords do not match.',
      });
    }
    if (value.next === value.current) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['next'],
        message: 'Choose a password you have not used here before.',
      });
    }
  });
export type PasswordChangeInput = z.infer<typeof PasswordChangeSchema>;
