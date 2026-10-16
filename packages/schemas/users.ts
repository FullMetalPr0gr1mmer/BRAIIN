import { z } from 'zod';
import { UuidSchema } from './primitives';
import { UserInviteSchema } from './admin';

// Users & roles v2 (Admin v2 U12a): the Security card, handing ownership on, and the
// colleague directory the users screen joins to the profiles. The database holds the same
// rules (migration 0055): `session_max_days in (1, 7)` and the invite domain's pattern.

/** The session lengths on offer, in days: 7 is the session cookie's own Max-Age (F7). */
export const SESSION_LENGTHS = [1, 7] as const;
export type SessionLength = (typeof SESSION_LENGTHS)[number];

/**
 * A domain name in lower case: labels of letters, digits and inner hyphens, at least two of
 * them, at most 253 characters. The same expression as admin_security_settings' CHECK.
 */
export const INVITE_DOMAIN_PATTERN =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** "Example.com", " @example.com " → "example.com"; empty → null. */
export const InviteDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value) => value.replace(/^@/, ''))
  .pipe(
    z
      .string()
      .max(253, 'Use 253 characters or fewer.')
      .refine(
        (value) => value === '' || INVITE_DOMAIN_PATTERN.test(value),
        'Enter a domain such as example.com, without the @ or a web address.',
      ),
  )
  .transform((value) => (value === '' ? null : value));

export const SecuritySettingsSchema = z
  .object({
    sessionMaxDays: z.union([z.literal(1), z.literal(7)]),
    inviteDomain: InviteDomainSchema.nullable(),
    /** The version the editor read: 0 before the row exists (the first save creates it). */
    version: z.number().int().min(0),
  })
  .strict();
export type SecuritySettingsInput = z.infer<typeof SecuritySettingsSchema>;

/** The new owner: from the path, `/api/admin/users/<id>/owner`. */
export const TransferOwnershipSchema = z.object({ to: UuidSchema }).strict();

/** One row of public.staff_accounts (0055), as PostgREST answers it. */
export const StaffAccountRowSchema = z.object({
  id: UuidSchema,
  email: z.string().nullable(),
  invited_at: z.string().nullable(),
  email_confirmed_at: z.string().nullable(),
  last_sign_in_at: z.string().nullable(),
  is_owner: z.boolean(),
});
export type StaffAccountRow = z.infer<typeof StaffAccountRowSchema>;

// ── Invites (Admin v2 U12b) ─────────────────────────────────────────────────────────────

/** The longest invite message, in characters (decision D9). */
export const INVITE_MESSAGE_MAX = 300;

/**
 * The optional note an Admin adds to an invite. GoTrue renders it into the invite e-mail from
 * the account's user metadata (`invite_message`) through Go's html/template, which escapes
 * it; it is cleared when the invite is accepted. Plain text: line breaks and tabs become
 * spaces, then any control or format character, `<` or `>` is refused, so nothing in it can
 * read as markup or hide what it says. Empty (after trimming) is no message.
 */
export const InviteMessageSchema = z
  .string()
  .transform((value) => value.replace(/[\t\r\n]+/g, ' ').trim())
  .pipe(
    z
      .string()
      .max(INVITE_MESSAGE_MAX, `Use ${INVITE_MESSAGE_MAX} characters or fewer.`)
      .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), 'Use plain text only.')
      .refine((value) => !/[<>]/.test(value), 'Leave out < and >.'),
  )
  .transform((value) => (value === '' ? null : value));

/** POST /api/admin/users: the invite, with its optional message. */
export const UserInviteV2Schema = UserInviteSchema.extend({
  message: InviteMessageSchema.nullish(),
});
export type UserInviteV2Input = z.infer<typeof UserInviteV2Schema>;
