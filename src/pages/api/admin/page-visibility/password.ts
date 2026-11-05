import { PagePasswordWriteSchema } from '@schemas/visibility';
import { defineAdminRoute } from '@/lib/admin/route';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { savePagePassword } from '@/lib/admin/pageVisibility';
import { syncVisibilityToEdge, visibilityPurgeTags } from '@/lib/admin/visibilitySync';
import { purgeAfterSave } from '@/lib/http/purge';
import { refuseStagedQuery } from '@/lib/release/releasesOff';
import { assertPasswordImmediate } from '@/lib/release/stagedPageVisibility';

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
// With releases on (Admin v2 R14b) the password stays immediate, a secret (P-3): the door
// changes the password of a page that already asks for one, with nothing pending on its setting
// and its message unchanged, which moves only the exempt `password_version` past 0066's guard;
// anything else is refused in words (`assertPasswordImmediate`). The screen sends it marked
// (`?staged=1`) in release mode, and with releases off such a request is refused (409
// `releases-off`) rather than taken as a live mode change the screen never offered.
//
// There is no audit row written HERE on purpose: the database writes `page_visibility
// .password_set` inside the same transaction as the change, so a change whose audit row
// cannot be chained does not happen at all.
export const prerender = false;

export const POST = defineAdminRoute({
  cap: 'maintenance.manage',
  input: PagePasswordWriteSchema,
  handler: async (ctx) => {
    const { auth, sb, input } = ctx;
    if (await ctx.releasesEnabled()) {
      // The person first (§9 b): a stale token is refused before the setting is read.
      await liveRecheck(auth);
      await assertPasswordImmediate(ctx, input);
    } else {
      refuseStagedQuery(ctx.url, 'page_visibility');
      await liveRecheck(auth);
    }
    const { setting, slug } = await savePagePassword(sb, auth, input);
    const sync = await syncVisibilityToEdge(sb, auth);
    // A page behind a password leaves the menus, the sitemap and llms.txt of every cached page
    // (the page itself is gated before any cache lookup: Admin v2 R7; nothing is sent while no
    // cache zone is set up, O-3).
    const purgeTags = visibilityPurgeTags({ kind: 'page', slug });
    await purgeAfterSave(auth.tenantId, purgeTags, 'visibility');
    return { setting, kvSynced: sync.kvSynced, purgeTags };
  },
});
