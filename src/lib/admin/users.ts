import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext, Role } from '@/lib/auth/types';
import { isRole } from '@/lib/auth/types';
import { StaffAccountRowSchema, type StaffAccountRow } from '@schemas/users';
import { UuidSchema } from '@schemas/primitives';
import { serviceClient } from '@/lib/supabase/server';
import { listRows } from './crud';
import { NotFoundError, ValidationError } from './errors';
import type { RateLimitOptions } from './rateLimit';
import {
  INVITE_ALREADY_JOINED,
  OWNER_PROTECTED,
  OWNER_PROTECTED_CODE,
  isPendingInvite,
  securityFromRow,
  userStatus,
  type UserRow,
} from './userModel';

// Users & roles v2 (Admin v2 U12a): what the users screen and its routes share. The screen
// reads people through the Admin's own session, so both server layers decide: RLS (since
// 0055 a RESTRICTIVE live check on reading colleagues' profiles) and assertCap('users.manage')
// in the route. Colleagues' e-mails and sign-in times come from public.staff_accounts, a
// definer that answers a live Admin of the token's tenant only.

// The pure rules and words (client-safe) live in ./userModel; re-exported for the routes.
export * from './userModel';

const PROFILE_COLUMNS = 'id,role,is_active,display_name,locked_until,created_at,is_owner';

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** One profile joined to its account, as the screen shows it; null for a row it cannot read. */
function toUserRow(
  profile: Record<string, unknown>,
  account: StaffAccountRow | undefined,
  now: number,
): UserRow | null {
  const id = text(profile['id']);
  const role = profile['role'];
  if (id === null || !isRole(role)) return null;
  const partial = {
    isActive: profile['is_active'] === true,
    lockedUntil: text(profile['locked_until']),
    invitedAt: account?.invited_at ?? null,
    confirmed: (account?.email_confirmed_at ?? null) !== null,
    lastSignInAt: account?.last_sign_in_at ?? null,
  };
  return {
    id,
    role,
    displayName: text(profile['display_name']),
    createdAt: text(profile['created_at']),
    email: account?.email ?? null,
    isOwner: profile['is_owner'] === true,
    twoStep: typeof account?.two_step === 'boolean' ? account.two_step : null,
    ...partial,
    status: userStatus(partial, now),
  };
}

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
): Promise<{
  rows: UserRow[];
  total: number;
  hasOwner: boolean | null;
  pending: UserRow[];
  withoutTwoStep: number | null;
}> {
  const [{ rows: profiles, total }, accounts] = await Promise.all([
    listRows<Record<string, unknown>>(sb, 'profiles', auth, {
      columns: PROFILE_COLUMNS,
      orderBy: { column: 'created_at', ascending: true },
      limit: page.limit,
      offset: page.offset,
    }),
    staffAccounts(sb, auth.tenantId),
  ]);
  const byId = new Map((accounts ?? []).map((account) => [account.id, account]));
  const rows: UserRow[] = [];
  for (const profile of profiles) {
    const row = toUserRow(profile, byId.get(String(profile['id'])), now);
    if (row) rows.push(row);
  }
  // Whether the tenant has an owner: the directory sees every profile (up to 200); when it
  // cannot be read, this page's own rows can only say "yes" (an owner listed here) or
  // "unknown", never "no owner", which the screen would then wrongly announce.
  const hasOwner =
    accounts !== null
      ? accounts.some((account) => account.is_owner)
      : rows.some((row) => row.isOwner)
        ? true
        : null;
  const pending = await pendingInvites(sb, auth, accounts, rows, now);
  return { rows, total, hasOwner, pending, withoutTwoStep: accountsWithoutTwoStep(accounts) };
}

/**
 * Pending invites (Admin v2 U12b): every account of the tenant not yet joined
 * (isPendingInvite), wherever it falls in the list's pages. The directory names them (it
 * lists every profile, up to 200); those on this page are already read, and the rest are
 * read in one more request, through the same RLS-bound session. None when the directory
 * cannot be read.
 */
async function pendingInvites(
  sb: SupabaseClient,
  auth: AuthContext,
  accounts: StaffAccountRow[] | null,
  pageRows: readonly UserRow[],
  now: number,
): Promise<UserRow[]> {
  if (!accounts) return [];
  const pendingAccounts = accounts.filter((account) =>
    isPendingInvite({
      invitedAt: account.invited_at,
      confirmed: account.email_confirmed_at !== null,
      lastSignInAt: account.last_sign_in_at,
    }),
  );
  if (pendingAccounts.length === 0) return [];
  const onPage = new Map(pageRows.map((row) => [row.id, row]));
  const missing = pendingAccounts.map((account) => account.id).filter((id) => !onPage.has(id));
  const read = new Map<string, UserRow>();
  if (missing.length > 0) {
    try {
      const { data, error } = await sb
        .from('profiles')
        .select(PROFILE_COLUMNS)
        .eq('tenant_id', auth.tenantId)
        .in('id', missing);
      if (!error && Array.isArray(data)) {
        const byId = new Map(accounts.map((account) => [account.id, account]));
        for (const profile of data as Record<string, unknown>[]) {
          const row = toUserRow(profile, byId.get(String(profile['id'])), now);
          if (row) read.set(row.id, row);
        }
      }
    } catch {
      // Fails soft, as the directory does: the card lists what this page could read.
    }
  }
  return pendingAccounts.flatMap((account) => {
    const row = onPage.get(account.id) ?? read.get(account.id);
    return row ? [row] : [];
  });
}

// ── Invites (Admin v2 U12b) ───────────────────────────────────────────────────────────

/**
 * Sending an invite, first or again: 10 an hour per Admin, 30 per tenant (privileged_ops,
 * failing closed). Each is a GoTrue call that sends an e-mail from the site's own sender, so
 * the ceiling bounds what a stolen Admin session could make the site send.
 */
export const INVITE_LIMITS: RateLimitOptions = {
  perUser: 10,
  perTenant: 30,
  windowMinutes: 60,
};

/** The privileged_ops key the invite and the resend share. */
export const INVITE_OP = 'user-invite';

/** The allowed invite domain (0055), read through the Admin's session; null for none. */
export async function inviteDomainOf(sb: SupabaseClient, tenantId: string): Promise<string | null> {
  const { data, error } = await sb
    .from('admin_security_settings')
    .select('session_max_days,invite_domain,version')
    .eq('tenant_id', tenantId)
    .maybeSingle<Record<string, unknown>>();
  if (error) throw new Error(`read security settings: ${error.message}`);
  return securityFromRow(data ?? null).inviteDomain;
}

/** A pending invite, as Resend and Cancel act on it. */
export interface InviteTarget {
  id: string;
  role: Role;
  isActive: boolean;
  email: string;
}

/**
 * The invite a Resend or a Cancel names, checked in this order: the id's shape; the profile
 * read through the Admin's session (RLS: the tenant and the live check), so another tenant's
 * account is a 404, as in PATCH; never yourself; never the account owner; then its account,
 * read as the service role (GoTrue's admin API), which must still be a pending invite (D7:
 * refused once the person has joined).
 */
export async function pendingInviteTarget(
  sb: SupabaseClient,
  auth: AuthContext,
  rawId: string | undefined,
): Promise<InviteTarget> {
  const parsed = UuidSchema.safeParse(rawId);
  if (!parsed.success) throw new NotFoundError('profile');
  const id = parsed.data;
  const { data: profile, error } = await sb
    .from('profiles')
    .select('id,role,is_active,is_owner')
    .eq('tenant_id', auth.tenantId)
    .eq('id', id)
    .maybeSingle<{ id: string; role: unknown; is_active: unknown; is_owner?: unknown }>();
  if (error) throw new Error(`read profile: ${error.message}`);
  if (!profile || !isRole(profile.role)) throw new NotFoundError('profile');
  if (id === auth.userId) throw new ValidationError(INVITE_ALREADY_JOINED, 'invite');
  if (profile.is_owner === true) throw new ValidationError(OWNER_PROTECTED, OWNER_PROTECTED_CODE);

  const { data: account, error: accountError } = await serviceClient().auth.admin.getUserById(id);
  if (accountError || !account?.user) {
    if ((accountError?.status ?? 0) === 404) throw new NotFoundError('profile');
    throw new Error(`read account: ${accountError?.message ?? 'none'}`);
  }
  const user = account.user;
  const pending = isPendingInvite({
    invitedAt: user.invited_at ?? null,
    confirmed: (user.email_confirmed_at ?? null) !== null,
    lastSignInAt: user.last_sign_in_at ?? null,
  });
  if (!pending || !user.email) throw new ValidationError(INVITE_ALREADY_JOINED, 'invite');
  return { id, role: profile.role, isActive: profile.is_active === true, email: user.email };
}

/**
 * How many active members have no verified second factor (Admin v2 U17), across the whole
 * directory rather than one page of the list: the Require 2FA confirm and the health check
 * say it. Null when the directory cannot be read or predates 0072 (no `two_step`).
 */
export function accountsWithoutTwoStep(accounts: readonly StaffAccountRow[] | null): number | null {
  if (!accounts) return null;
  if (accounts.some((a) => a.two_step === undefined || a.is_active === undefined)) return null;
  return accounts.filter((a) => a.is_active === true && a.two_step !== true).length;
}

/** public.staff_accounts for the caller's tenant; null when it cannot be read. */
export async function staffAccounts(
  sb: SupabaseClient,
  tenantId: string,
): Promise<StaffAccountRow[] | null> {
  try {
    const { data, error } = await sb.rpc('staff_accounts', { p_tenant: tenantId });
    if (error || !Array.isArray(data)) return null;
    return data.flatMap((row: unknown) => {
      const parsed = StaffAccountRowSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    return null;
  }
}
