import { defineAdminRoute, json } from '@/lib/admin/route';
import { ValidationError } from '@/lib/admin/errors';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { claimPrivilegedOp } from '@/lib/admin/rateLimit';
import { authEmailReady, invitePageUrl } from '@/lib/auth/recovery';
import { serviceClient } from '@/lib/supabase/server';
import {
  INVITE_LIMITS,
  INVITE_OP,
  INVITE_SWITCHED_OFF,
  inviteDomainOf,
  inviteDomainRefusal,
  pendingInviteTarget,
} from '@/lib/admin/users';

// Resend an invite (Admin v2 U12b; `users.manage`, Admin only). An invite link works for an
// hour (decision D1: GoTrue's otp_expiry, which reset links share), so a person who missed
// it is sent a new one. GoTrue's invite call sends again for an account that has not joined
// (decision D8; it refuses a joined one), with a fresh token, so the old link stops working.
// The message the first invite carried is still in the account's metadata, and goes again.
//
// Switched off while the site cannot send e-mail (503 `not-set-up`, as the invite). Then
// the live recheck, the invite itself (pendingInviteTarget: this tenant through RLS, never
// yourself or the owner, not joined), the account switched on (a switched-off one could not
// accept), the allowed domain as it stands now, the invite limit the first invite counts
// against too, and the audit row (`user.invite_resend`, the role, never the address: D5).

export const prerender = false;

export const POST = defineAdminRoute({
  cap: 'users.manage',
  handler: async ({ auth, sb, params, audit }) => {
    if (!authEmailReady()) return json({ ok: false, error: 'not-set-up' }, 503);

    await liveRecheck(auth);

    const target = await pendingInviteTarget(sb, auth, params['id']);
    if (!target.isActive) throw new ValidationError(INVITE_SWITCHED_OFF, 'invite');
    const refusal = inviteDomainRefusal(target.email, await inviteDomainOf(sb, auth.tenantId));
    if (refusal) throw new ValidationError(refusal, 'invite');

    await claimPrivilegedOp(auth, INVITE_OP, INVITE_LIMITS);

    const { error } = await serviceClient().auth.admin.inviteUserByEmail(target.email, {
      redirectTo: invitePageUrl(),
    });
    if (error) {
      // GoTrue refusing (the person joined a moment ago, or its own e-mail throttle) is the
      // admin's to read; anything else is ours.
      const status = error.status ?? 0;
      if (status >= 400 && status < 500) {
        throw new ValidationError('The invite could not be sent again. Try again later.', 'invite');
      }
      throw new Error(`resend invite: ${error.message}`);
    }

    audit({
      action: 'user.invite_resend',
      entityType: 'profile',
      entityId: target.id,
      detail: { role: target.role },
    });
    return { id: target.id, resent: true };
  },
});
