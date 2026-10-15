import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext, Role } from '@/lib/auth/types';
import { isRole } from '@/lib/auth/types';
import { StaffAccountRowSchema, type StaffAccountRow } from '@schemas/users';
import { listRows } from './crud';

// Users & roles v2 (Admin v2 U12a): what the users screen and its routes share. The screen
// reads people through the Admin's own session, so both server layers decide: RLS (since
// 0055 a RESTRICTIVE live check on reading colleagues' profiles) and assertCap('users.manage')
// in the route. Colleagues' e-mails and sign-in times come from public.staff_accounts, a
// definer that answers a live Admin of the token's tenant only.

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
  if (row.invitedAt !== null && !row.confirmed && row.lastSignInAt === null) return 'invited';
  return 'active';
}

/** The words for an access state. */
export const STATUS_LABEL: Readonly<Record<UserStatus, string>> = {
  active: 'Active',
  removed: 'Removed',
  locked: 'Locked',
  invited: 'Invited',
};

const PROFILE_COLUMNS = 'id,role,is_active,display_name,locked_until,created_at,is_owner';

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * The users screen's rows: one page of the tenant's profiles (through RLS), each joined to
 * its account (public.staff_accounts). The directory failing (an outage, 0055 not applied)
 * leaves the e-mails empty rather than the screen: the profiles still decide who is listed.
 */
export async function loadUsers(
  sb: SupabaseClient,
  auth: AuthContext,
  page: { limit: number; offset: number },
  now: number = Date.now(),
): Promise<{ rows: UserRow[]; total: number; hasOwner: boolean }> {
  const [{ rows: profiles, total }, accounts] = await Promise.all([
    listRows<Record<string, unknown>>(sb, 'profiles', auth, {
      columns: PROFILE_COLUMNS,
      orderBy: { column: 'created_at', ascending: true },
      limit: page.limit,
      offset: page.offset,
    }),
    staffAccounts(sb, auth.tenantId),
  ]);
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const rows: UserRow[] = [];
  for (const profile of profiles) {
    const id = text(profile['id']);
    const role = profile['role'];
    if (id === null || !isRole(role)) continue;
    const account = byId.get(id);
    const partial = {
      isActive: profile['is_active'] === true,
      lockedUntil: text(profile['locked_until']),
      invitedAt: account?.invited_at ?? null,
      confirmed: (account?.email_confirmed_at ?? null) !== null,
      lastSignInAt: account?.last_sign_in_at ?? null,
    };
    rows.push({
      id,
      role,
      displayName: text(profile['display_name']),
      createdAt: text(profile['created_at']),
      email: account?.email ?? null,
      isOwner: profile['is_owner'] === true,
      ...partial,
      status: userStatus(partial, now),
    });
  }
  return { rows, total, hasOwner: accounts.some((account) => account.is_owner) };
}

/** public.staff_accounts for the caller's tenant; empty when it cannot be read. */
async function staffAccounts(sb: SupabaseClient, tenantId: string): Promise<StaffAccountRow[]> {
  try {
    const { data, error } = await sb.rpc('staff_accounts', { p_tenant: tenantId });
    if (error || !Array.isArray(data)) return [];
    return data.flatMap((row: unknown) => {
      const parsed = StaffAccountRowSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    return [];
  }
}

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
  /** 0 before the row exists: the first save creates it. */
  version: number;
}

export const SECURITY_DEFAULTS: SecuritySettings = {
  sessionMaxDays: 7,
  inviteDomain: null,
  version: 0,
};

/** A row of admin_security_settings as the screen shows it; the defaults for none. */
export function securityFromRow(row: Record<string, unknown> | null): SecuritySettings {
  if (!row) return { ...SECURITY_DEFAULTS };
  return {
    sessionMaxDays: row['session_max_days'] === 1 ? 1 : 7,
    inviteDomain: text(row['invite_domain']),
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
