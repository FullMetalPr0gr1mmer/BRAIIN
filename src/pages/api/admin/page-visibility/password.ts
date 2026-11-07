import { z } from 'zod';
import { PagePasswordWriteSchema } from '@schemas/visibility';
import { defineAdminRoute } from '@/lib/admin/route';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { savePagePassword } from '@/lib/admin/pageVisibility';
import { syncVisibilityToEdge, visibilityPurgeTags } from '@/lib/admin/visibilitySync';
import { purgeAfterSave } from '@/lib/http/purge';
import { refuseStagedQuery } from '@/lib/release/releasesOff';
import { stagedPasswordWrite } from '@/lib/release/stagedPageVisibility';

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
// With releases on (Admin v2 R14e, owner item B1 option b) the door splits the change, because a
// secret is immediate and no release carries one (P-3): after the same live recheck,
// `stagedPasswordWrite` stores the secret at once (`public.store_page_password`, which moves only
// the exempt `password_version` of a page already behind a password live) and stages the mode
// and the message as the page's visibility change, so the page asks for the password once that
// change is published. The screen sends it marked (`?staged=1`, and the pending change it names
// in the body), and with releases off such a request is refused (409 `releases-off`) rather than
// taken as a live mode change the screen never offered. The body is parsed in the handler (a
// staged one names its pending change, which the strict schema refuses), with the same 422.
//
// There is no audit row written HERE on purpose: the database writes `page_visibility
// .password_set` (`.password_stored` with releases on) inside the same transaction as the
// change, so a change whose audit row cannot be chained does not happen at all.
export const prerender = false;

export const POST = defineAdminRoute({
  cap: 'maintenance.manage',
  // Parsed in the handler: a staged write also names `draftId`/`draftVersion`.
  input: z.unknown(),
  handler: async (ctx) => {
    const { auth, sb } = ctx;
    if (await ctx.releasesEnabled()) {
      // The person first (§9 b): a stale token is refused before the setting is read.
      await liveRecheck(auth);
      return stagedPasswordWrite(ctx, ctx.input);
    }
    const input = PagePasswordWriteSchema.parse(ctx.input);
    refuseStagedQuery(ctx.url, 'page_visibility');
    await liveRecheck(auth);
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
