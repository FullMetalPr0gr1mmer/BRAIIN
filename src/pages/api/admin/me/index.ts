import { DisplayNameSchema } from '@schemas/adminPrefs';
import { updateMyDisplayName } from '@/lib/admin/account';
import { defineAdminRoute } from '@/lib/admin/route';

// PATCH /api/admin/me: the signed-in person renames themselves (Admin v2 F8, the account
// drawer). Any member: `analytics.read` is the gate every staff role holds, as the search
// route's is; what may change is decided by update_my_profile() (0044), which writes one
// column of the caller's own row after its own live check. Audited.

export const prerender = false;

export const PATCH = defineAdminRoute({
  cap: 'analytics.read',
  input: DisplayNameSchema,
  handler: async ({ auth, sb, input, audit }) => {
    const displayName = await updateMyDisplayName(sb, auth, input.display_name);
    audit({
      action: 'profile.update',
      entityType: 'profile',
      entityId: auth.userId,
      detail: { fields: ['display_name'] },
    });
    return { display_name: displayName };
  },
});
