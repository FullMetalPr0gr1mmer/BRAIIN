import { defineAdminRoute } from '@/lib/admin/route';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { serviceClient } from '@/lib/supabase/server';
import { pendingInviteTarget } from '@/lib/admin/users';

// Cancel an invite (Admin v2 U12b; `users.manage`, Admin only): DELETE removes an account
// that has not joined yet, so its link stops working. Decision D7: refused once the person
// has confirmed or ever signed in (Remove access is the way then: it keeps the account and
// everything they made), and for the account owner (0055's guard refuses the delete in the
// database too). Works while e-mail is not set up: cancelling sends nothing.
//
// The live recheck, then the invite (pendingInviteTarget: this tenant through RLS, never
// yourself or the owner, not joined), then GoTrue's admin delete as the service role. The
// profile goes with the account (profiles.id references auth.users on delete cascade); audit
// rows keep the id. Audited `user.invite_cancel` with the role, never the address (D5).

export const prerender = false;

export const DELETE = defineAdminRoute({
  cap: 'users.manage',
  handler: async ({ auth, sb, params, audit }) => {
    await liveRecheck(auth);

    const target = await pendingInviteTarget(sb, auth, params['id']);

    const { error } = await serviceClient().auth.admin.deleteUser(target.id);
    if (error) throw new Error(`cancel invite: ${error.message}`);

    audit({
      action: 'user.invite_cancel',
      entityType: 'profile',
      entityId: target.id,
      detail: { role: target.role },
    });
    return { id: target.id, cancelled: true };
  },
});
