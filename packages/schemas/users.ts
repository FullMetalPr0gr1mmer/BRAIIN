import { z } from 'zod';
import { UuidSchema } from './primitives';

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
