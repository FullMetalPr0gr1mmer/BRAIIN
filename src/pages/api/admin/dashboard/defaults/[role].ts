import { RoleDefaultsPutSchema } from '@schemas/dashboard';
import { isRole } from '@/lib/auth/types';
import { resetRolePreset, saveRolePreset } from '@/lib/admin/dashboard/roleDefaults';
import { NotFoundError } from '@/lib/admin/errors';
import { defineAdminRoute } from '@/lib/admin/route';

// One role's dashboard preset (Admin v2 U1, README U1 D1 to D3): users.manage, Admin only,
// and the database asks the same of the LIVE role (admin_role_defaults_*, 0060).
//   PUT     the role's layout, its quick actions (library ids only: a preset never carries a
//           link), or both, under the version the Admin read (0: none yet); ids the role may
//           not use are refused (422); audited `dashboard.defaults.update` with the role and
//           the fields saved, never their values.
//   DELETE  back to the code's default; audited `dashboard.defaults.reset`.
// The role comes from the path and must be one of the four (404 otherwise).

export const prerender = false;

function roleOf(params: Record<string, string | undefined>) {
  const role = params['role'];
  if (!isRole(role)) throw new NotFoundError('role');
  return role;
}

export const PUT = defineAdminRoute({
  cap: 'users.manage',
  input: RoleDefaultsPutSchema,
  handler: async ({ auth, sb, input, params, audit }) => {
    const role = roleOf(params);
    const saved = await saveRolePreset(sb, auth, role, input);
    audit({
      action: 'dashboard.defaults.update',
      entityType: 'admin_role_defaults',
      entityId: role,
      detail: {
        role,
        fields: [
          ...(input.dashboard ? ['dashboard'] : []),
          ...(input.quickActions ? ['quick_actions'] : []),
        ],
      },
    });
    return saved;
  },
});

export const DELETE = defineAdminRoute({
  cap: 'users.manage',
  handler: async ({ auth, sb, params, audit }) => {
    const role = roleOf(params);
    const removed = await resetRolePreset(sb, auth, role);
    if (removed) {
      audit({
        action: 'dashboard.defaults.reset',
        entityType: 'admin_role_defaults',
        entityId: role,
        detail: { role },
      });
    }
    return { role, removed };
  },
});
