import { readRolePresets } from '@/lib/admin/dashboard/roleDefaults';
import { defineAdminRoute } from '@/lib/admin/route';

// GET /api/admin/dashboard/defaults: every role's dashboard preset (Admin v2 U1, README U1
// D1): users.manage, Admin only, as the database's read policy gives Admin alone every
// role's row. A role with no preset comes back at version 0 (the code's default applies).

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'users.manage',
  handler: async ({ auth, sb }) => ({ presets: await readRolePresets(sb, auth) }),
});
