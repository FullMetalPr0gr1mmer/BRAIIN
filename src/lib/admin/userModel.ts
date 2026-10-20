import type { Role } from '@/lib/auth/types';

// The users screen's model (Admin v2 U12a): the pure rules and the words the screen, its
// island and its routes share. No server code here (the island imports it); the loader is
// src/lib/admin/users.ts.

/** Where a person's access stands, as the table shows it. */
export type UserStatus = 'active' | 'removed' | 'locked' | 'invited';

/** One person on the users screen. */
export interface UserRow {
  id: string;
  role: Role;
  isActive: boolean;
  displayName: string | null;
  lockedUntil: string | null;
  createdAt: string | null;
  email: string | null;
  invitedAt: string | null;
  /** The e-mail is confirmed (an invite accepted, or an account created confirmed). */
  confirmed: boolean;
  lastSignInAt: string | null;
  isOwner: boolean;
  /**
   * A verified authenticator app (Admin v2 U17, staff_accounts.two_step); null when the
   * directory could not be read or predates 0072 (the table shows a dash).
   */
  twoStep: boolean | null;
  status: UserStatus;
}

/** What the table says about a person: removed, locked, invited (never signed in), active. */
export function userStatus(
  row: {
    isActive: boolean;
    lockedUntil: string | null;
    invitedAt: string | null;
    confirmed: boolean;
    lastSignInAt: string | null;
  },
  now: number = Date.now(),
): UserStatus {
  if (!row.isActive) return 'removed';
  if (row.lockedUntil !== null && Date.parse(row.lockedUntil) > now) return 'locked';
  if (isPendingInvite(row)) return 'invited';
  return 'active';
}

// ── Invites (Admin v2 U12b) ───────────────────────────────────────────────────────────

/**
 * An invite nobody has accepted yet: the account was invited, its e-mail is not confirmed
 * and it has never signed in. Only such an account can be sent its invite again (Resend) or
 * cancelled (decision D7: refused once the person has joined, or for the owner).
 */
export function isPendingInvite(row: {
  invitedAt: string | null;
  confirmed: boolean;
  lastSignInAt: string | null;
}): boolean {
  return row.invitedAt !== null && !row.confirmed && row.lastSignInAt === null;
}

/** Cancel is refused for anyone who has joined, and for the account owner. */
export function canCancelInvite(
  row: Pick<UserRow, 'invitedAt' | 'confirmed' | 'lastSignInAt' | 'isOwner'>,
): boolean {
  return isPendingInvite(row) && !row.isOwner;
}

/** Resend, besides: the account can sign in (a switched-off one could not accept). */
export function canResendInvite(
  row: Pick<UserRow, 'invitedAt' | 'confirmed' | 'lastSignInAt' | 'isOwner' | 'isActive'>,
): boolean {
  return canCancelInvite(row) && row.isActive;
}

/** What the invite controls say while the site cannot send e-mail (owner items O-2, O-22). */
export const INVITES_NOT_SET_UP = {
  title: 'Not set up',
  text: 'Email delivery is not connected yet, so invites cannot be sent. Pending invites can still be cancelled.',
} as const;

/** How long an invite link works (decision D1: GoTrue's otp_expiry, shared with reset links). */
export const INVITE_LINK_LIFETIME = 'The link works for one hour. Resend it if it runs out.';

/** Resend or Cancel refused: the person has joined since the list was read. */
export const INVITE_ALREADY_JOINED =
  'They have already joined, so there is no invite to resend or cancel. Use Remove access instead.';

/** Resend refused: the account is switched off. */
export const INVITE_SWITCHED_OFF =
  'Their access is switched off. Switch Can sign in back on before resending the invite.';

/** An invite to an address that already has an account here. */
export const INVITE_EXISTS =
  'That address already has an account here. If they have not joined yet, use Resend in Pending invites.';

/** What a person is called on screen: their name, else their e-mail, else a short id. */
export function personName(row: Pick<UserRow, 'displayName' | 'email' | 'id'>): string {
  return row.displayName?.trim() || row.email || `Account ${row.id.slice(0, 8)}`;
}

/** The words for an access state. */
export const STATUS_LABEL: Readonly<Record<UserStatus, string>> = {
  active: 'Active',
  removed: 'Removed',
  locked: 'Locked',
  invited: 'Invited',
};

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

// ── Owner protection (0055: profiles.is_owner; the database guard is the second layer) ──

/** The sentence a refused change of the account owner answers with. */
export const OWNER_PROTECTED =
  'The account owner keeps the Admin role. They can hand ownership to another Admin first.';

/** The ValidationError field an owner refusal carries, so the screen can tell it apart. */
export const OWNER_PROTECTED_CODE = 'owner-protected';

/** "Make account owner" refused: the caller is not the owner. */
export const NOT_OWNER = 'Only the account owner can hand ownership on.';

/** "Make account owner" refused: the person chosen cannot be the owner. */
export const BAD_TARGET = 'Choose another active Admin to be the account owner.';

/** Whether a change would demote or switch off the account owner (refused, both layers). */
export function ownerRefusal(
  target: { is_owner?: unknown },
  input: { role?: Role | undefined; isActive?: boolean | undefined },
): boolean {
  if (target.is_owner !== true) return false;
  return (input.role !== undefined && input.role !== 'admin') || input.isActive === false;
}

/** The database's own refusal of the same change (app.tg_profiles_owner_guard). */
export function isOwnerGuardError(error: { code?: string; message?: string } | null): boolean {
  return error?.code === '42501' && error.message === 'owner_protected';
}

// ── The Security card ─────────────────────────────────────────────────────────────────

export interface SecuritySettings {
  sessionMaxDays: 1 | 7;
  inviteDomain: string | null;
  /** "Require 2FA for everyone" (Admin v2 U17, 0072). */
  requireMfa: boolean;
  /** 0 before the row exists: the first save creates it. */
  version: number;
}

export const SECURITY_DEFAULTS: SecuritySettings = {
  sessionMaxDays: 7,
  inviteDomain: null,
  requireMfa: false,
  version: 0,
};

/** A row of admin_security_settings as the screen shows it; the defaults for none. */
export function securityFromRow(row: Record<string, unknown> | null): SecuritySettings {
  if (!row) return { ...SECURITY_DEFAULTS };
  return {
    sessionMaxDays: row['session_max_days'] === 1 ? 1 : 7,
    inviteDomain: text(row['invite_domain']),
    requireMfa: row['require_mfa'] === true,
    version: typeof row['version'] === 'number' ? row['version'] : 0,
  };
}

/**
 * Why an invite to this address is refused, or null: with a domain set, only addresses at
 * exactly that domain (a subdomain is another domain).
 */
export function inviteDomainRefusal(email: string, domain: string | null): string | null {
  if (domain === null) return null;
  const at = email.lastIndexOf('@');
  const host =
    at < 0
      ? ''
      : email
          .slice(at + 1)
          .trim()
          .toLowerCase();
  return host === domain ? null : `Only ${domain} addresses can be invited. Change it in Security.`;
}

// ── Two factor authentication (Admin v2 U17) ──────────────────────────────────────────

/** Reset 2FA refused: it is the caller's own (they turn it off on their own account). */
export const TWO_STEP_SELF_RESET =
  'You cannot reset your own 2FA here. Manage it from your account instead.';

/** Reset 2FA refused for the account owner (launch runbook §3a: whoever runs the database). */
export const TWO_STEP_OWNER_RESET =
  "Only whoever runs the database can reset the account owner's 2FA.";

/** Reset 2FA refused: the person has no authenticator app (nothing to reset, nobody signed out). */
export const TWO_STEP_NOTHING_TO_RESET = 'They do not use 2FA, so there is nothing to reset.';

/** Require 2FA refused: the Admin saving it does not use 2FA themselves (decision D5). */
export const REQUIRE_MFA_SELF_FIRST = 'Turn on 2FA for your own account first.';

/** Whether an Admin can reset this person's 2FA from the users screen. */
export function canResetTwoStep(
  row: Pick<UserRow, 'id' | 'isOwner' | 'twoStep'>,
  selfId: string,
): boolean {
  return row.twoStep === true && !row.isOwner && row.id !== selfId;
}

/** Require 2FA's confirm: the sentence about who is not set up yet. */
export function notSetUpSentence(count: number | null): string {
  if (count === null) return 'Some people may not have set it up yet.';
  if (count === 0) return 'Everyone has set it up already.';
  return count === 1
    ? '1 person has not set it up yet.'
    : `${count} people have not set it up yet.`;
}
