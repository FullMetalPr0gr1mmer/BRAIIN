import { TransferOwnershipSchema } from '@schemas/users';
import { defineAdminRoute } from '@/lib/admin/route';
import { NotFoundError, ValidationError } from '@/lib/admin/errors';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { AuthorizationError } from '@/lib/authz/errors';
import { BAD_TARGET, NOT_OWNER } from '@/lib/admin/users';

// "Make account owner" (Admin v2 U12a): the account owner hands ownership to another active
// Admin. `users.manage` (Admin only), the live recheck, then the Worker's own owner check
// (a non-owner Admin is answered 422 before the database is asked), then
// public.transfer_ownership, which checks all of it again as the database sees it (the
// caller a live Admin of the token's tenant and its owner; the target an active, unlocked
// Admin of the same tenant), moves the marker and writes the audit row in one transaction.
// Ownership is never claimed: it moves only by the owner's own action (0055).

export const prerender = false;

export const POST = defineAdminRoute({
  cap: 'users.manage',
  handler: async ({ auth, sb, params }) => {
    const parsed = TransferOwnershipSchema.safeParse({ to: params['id'] });
    if (!parsed.success) throw new NotFoundError('profile');
    const to = parsed.data.to;

    await liveRecheck(auth);

    const { data: self, error: selfError } = await sb
      .from('profiles')
      .select('is_owner')
      .eq('tenant_id', auth.tenantId)
      .eq('id', auth.userId)
      .maybeSingle<{ is_owner?: unknown }>();
    if (selfError) throw new Error(`read own profile: ${selfError.message}`);
    if (self?.is_owner !== true) throw new ValidationError(NOT_OWNER, 'owner');
    if (to === auth.userId) throw new ValidationError(BAD_TARGET, 'owner');

    const { error } = await sb.rpc('transfer_ownership', { p_tenant: auth.tenantId, p_to: to });
    if (error) {
      if (error.code === '22023') throw new ValidationError(BAD_TARGET, 'owner');
      if (error.code === '42501') {
        throw new AuthorizationError('users.manage', 'the database refused the transfer');
      }
      throw new Error(`transfer ownership: ${error.message}`);
    }
    // The RPC wrote the audit row (user.ownership_transfer) in its own transaction.
    return { owner: to };
  },
});
