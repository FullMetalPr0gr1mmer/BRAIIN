import { PagePasswordWriteSchema } from '@schemas/visibility';
import { defineAdminRoute } from '@/lib/admin/route';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { savePagePassword } from '@/lib/admin/pageVisibility';
import { syncVisibilityToEdge, visibilityPurgeTags } from '@/lib/admin/visibilitySync';
import { purgeAfterSave } from '@/lib/http/purge';

// POST /api/admin/page-visibility/password — put one page behind a password (Admin v2
// U14b), `maintenance.manage` (Admin + Developer, §5 "Maintenance / hidden pages / page
// visibility"). The mode's own door: the list's PUT takes public, hidden and link only,
// because a save that named `password` would have no password to set.
//
// The password goes straight from the request body to `public.set_page_password`, which
// checks the live profile, hashes it with bcrypt and writes the secret, the mode, the
// message and the new version in one transaction with its audit row (0061). This route
// stores nothing, logs nothing and returns nothing of it: the answer is the setting as the
// screen now reads it, with the message and the version count but never the password, and
// `kvSynced` for the edge.
//
// There is no audit row written HERE on purpose: the database writes `page_visibility
// .password_set` inside the same transaction as the change, so a change whose audit row
// cannot be chained does not happen at all.
export const prerender = false;

export const POST = defineAdminRoute({
  cap: 'maintenance.manage',
  input: PagePasswordWriteSchema,
  handler: async ({ auth, sb, input }) => {
    await liveRecheck(auth);
    const { setting, slug } = await savePagePassword(sb, auth, input);
    const sync = await syncVisibilityToEdge(sb, auth);
    // A cached copy of the page must not outlive its password (Admin v2 R7; nothing is sent
    // while no cache zone is set up, O-3).
    const purgeTags = visibilityPurgeTags({ kind: 'page', slug });
    await purgeAfterSave(auth.tenantId, purgeTags, 'visibility');
    return { setting, kvSynced: sync.kvSynced, purgeTags };
  },
});
