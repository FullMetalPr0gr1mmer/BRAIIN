import { UuidSchema } from '@schemas/primitives';
import { defineAdminRoute } from '@/lib/admin/route';
import { InUseError, NotFoundError, ValidationError } from '@/lib/admin/errors';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { AuthorizationError } from '@/lib/authz/errors';
import {
  OWNER_PROTECTED_CODE,
  TWO_STEP_NOTHING_TO_RESET,
  TWO_STEP_OWNER_RESET,
  TWO_STEP_SELF_RESET,
} from '@/lib/admin/users';

// "Reset 2FA" (Admin v2 U17): an Admin clears a colleague's authenticator app, for someone who
// lost their phone. `users.manage` (Admin only), the live recheck (a demoted, deactivated or
// locked Admin is refused before the database is asked, CLAUDE.md §9 (b)), then
// public.reset_two_step (0072), which checks all of it again as the database sees it (a live
// Admin of the token's tenant; the target in that tenant, not the caller, not the account
// owner, holding a factor), deletes the factors and every session of the target and writes the
// audit row (user.two_step_reset) in ONE transaction: a reset whose audit row cannot be written
// does not happen, so this route writes none of its own. Immediate (P-3): no release.

export const prerender = false;

export const POST = defineAdminRoute({
  cap: 'users.manage',
  handler: async ({ auth, sb, params }) => {
    const parsed = UuidSchema.safeParse(params['id']);
    if (!parsed.success) throw new NotFoundError('profile');
    const target = parsed.data;

    await liveRecheck(auth);
    // The Worker's own word before the database's (both refuse it).
    if (target === auth.userId) throw new ValidationError(TWO_STEP_SELF_RESET, 'two-step');

    const { data, error } = await sb.rpc('reset_two_step', {
      p_tenant: auth.tenantId,
      p_user: target,
    });
    if (error) {
      if (error.code === '42501') {
        if (error.message === 'owner_protected') {
          throw new ValidationError(TWO_STEP_OWNER_RESET, OWNER_PROTECTED_CODE);
        }
        throw new AuthorizationError('users.manage', 'the database refused the reset');
      }
      if (error.code === '22023') {
        if (error.message === 'self') throw new ValidationError(TWO_STEP_SELF_RESET, 'two-step');
        if (error.message === 'nothing_to_reset') throw new InUseError(TWO_STEP_NOTHING_TO_RESET);
        throw new NotFoundError('profile');
      }
      throw new Error(`reset two-step: ${error.message}`);
    }
    return { factors: typeof data === 'number' ? data : 0 };
  },
});
