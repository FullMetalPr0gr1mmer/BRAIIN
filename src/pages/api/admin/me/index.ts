import { DisplayNameSchema } from '@schemas/adminPrefs';
import { updateMyDisplayName } from '@/lib/admin/account';
import { defineAdminRoute } from '@/lib/admin/route';

// PATCH /api/admin/me: the signed-in person renames themselves (Admin v2 F8, the account
// drawer). Any member: `analytics.read` is the gate every staff role holds, as the search
// route's is; what may change is decided by update_my_profile() (0044), which writes one
// column of the caller's own row after its own live check, under the same name rules as
// the schema here, and writes the `profile.update` audit row in the same transaction. So
// this route queues no audit row of its own: a second one would only repeat it.

export const prerender = false;

export const PATCH = defineAdminRoute({
  cap: 'analytics.read',
  input: DisplayNameSchema,
  handler: async ({ auth, sb, input }) => ({
    display_name: await updateMyDisplayName(sb, auth, input.display_name),
  }),
});
