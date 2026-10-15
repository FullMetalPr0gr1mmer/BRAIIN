import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { isRole } from '@/lib/auth/types';
import { StaffAccountRowSchema, type StaffAccountRow } from '@schemas/users';
import { listRows } from './crud';
import { userStatus, type UserRow } from './userModel';

// Users & roles v2 (Admin v2 U12a): what the users screen and its routes share. The screen
// reads people through the Admin's own session, so both server layers decide: RLS (since
// 0055 a RESTRICTIVE live check on reading colleagues' profiles) and assertCap('users.manage')
// in the route. Colleagues' e-mails and sign-in times come from public.staff_accounts, a
// definer that answers a live Admin of the token's tenant only.

// The pure rules and words (client-safe) live in ./userModel; re-exported for the routes.
export * from './userModel';

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
