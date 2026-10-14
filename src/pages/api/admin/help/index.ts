import { defineAdminRoute } from '@/lib/admin/route';
import { loadHelpIndex, screenOf } from '@/lib/admin/help';
import { HelpIndexQuerySchema } from '@schemas/help';

// GET /api/admin/help: the help drawer's list (Admin v2 U16). Every guide the caller's role
// may read (src/lib/admin/help decides from ROLE_CAPS; RLS keeps it to the caller's
// tenant), and which of them are for `screen`, the page the drawer was opened on. Asked when
// the drawer opens, never on a timer (Workers Free plan, P-15).
//
// `analytics.read` is the gate because it is the one capability every staff role holds
// (as for the bell and the command palette): every member has the help centre.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'analytics.read',
  input: HelpIndexQuerySchema,
  handler: async ({ auth, sb, input }) => loadHelpIndex(sb, auth, screenOf(input.screen)),
});
