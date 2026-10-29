import { AdminPrefsPutSchema } from '@schemas/adminPrefs';
import { hasColumns } from '@schemas/dashboard';
import { readMyDashboardPrefs, readMyPrefs, saveMyPrefs } from '@/lib/admin/prefs';
import {
  forbiddenActions,
  forbiddenWidgets,
  keepReleasePlacement,
  unnamedReleaseWidgets,
} from '@/lib/admin/dashboard/layout';
import { readMyRolePreset } from '@/lib/admin/dashboard/roleDefaults';
import { ValidationError } from '@/lib/admin/errors';
import { defineAdminRoute } from '@/lib/admin/route';

// GET/PUT /api/admin/me/preferences: the signed-in person's own preferences (Admin v2 F8;
// the row is `admin_user_prefs`, 0044, self only in RLS behind a live check). Any member.
// PUT carries the row's version (0 before the first save) and answers 409 when another
// tab saved first. The bell's settings (U11) and the dashboard (U1: its layout and quick
// actions) write here; a body may name any of the three, `notifications` alone included
// (the account drawer). A preference can mute or arrange what a role sees, never add to it:
// a widget or a library action the role may not use is refused (422), as is an id this build
// does not know (the schema). Not audited: nothing here changes what anyone may see or do.
//
// A layout that names a release widget (the publish card) nowhere keeps it where the stored
// layout had it (R14-prep code review 1): the board never shows the card while releases are off,
// so a save made then must not forget that the person hid or moved it. That costs a read of the
// person's own row (and of their role's preset when they have none), only for such a save; the
// update's version check still decides.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'analytics.read',
  handler: async ({ auth, sb }) => readMyPrefs(sb, auth),
});

export const PUT = defineAdminRoute({
  cap: 'analytics.read',
  input: AdminPrefsPutSchema,
  handler: async ({ auth, sb, input }) => {
    if (input.dashboard) {
      const bad = forbiddenWidgets(input.dashboard, auth.role);
      if (bad.length > 0) {
        throw new ValidationError(`Not available to your role: ${bad.join(', ')}`, 'dashboard');
      }
    }
    if (input.quickActions) {
      const bad = forbiddenActions(input.quickActions, auth.role);
      if (bad.length > 0) {
        throw new ValidationError(`Not available to your role: ${bad.join(', ')}`, 'quickActions');
      }
    }
    let dashboard = input.dashboard;
    if (dashboard && unnamedReleaseWidgets(dashboard, auth.role).length > 0) {
      // What the board showed: the person's own layout, else their role's preset (a first save
      // keeps the preset's hide too); with neither, the default place stays the card's.
      const mine = (await readMyDashboardPrefs(sb, auth)).dashboard;
      const shown = hasColumns(mine) ? mine : (await readMyRolePreset(sb, auth)).dashboard;
      dashboard = keepReleasePlacement(dashboard, shown, auth.role);
    }
    return saveMyPrefs(sb, auth, input.version, {
      notifications: input.notifications,
      dashboard,
      quickActions: input.quickActions,
    });
  },
});
