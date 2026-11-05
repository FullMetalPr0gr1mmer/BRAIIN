import { z } from 'zod';
import { PageVisibilityWriteSchema } from '@schemas/visibility';
import { defineAdminRoute } from '@/lib/admin/route';
import { purgeAfterSave } from '@/lib/http/purge';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { listVisibility, saveVisibility, settingOfRow } from '@/lib/admin/pageVisibility';
import {
  edgeVisibilityStatus,
  syncVisibilityToEdge,
  visibilityPurgeTags,
} from '@/lib/admin/visibilitySync';
import { refuseStagedBody } from '@/lib/release/releasesOff';
import { stagedVisibilityList, stagedVisibilityWrite } from '@/lib/release/stagedPageVisibility';

// Page visibility (Admin v2 U14a), `maintenance.manage` (Admin + Developer, §5 "Maintenance /
// hidden pages / page visibility"). RLS agrees in both layers (0057: the JWT role and the
// live profile), so this route is the secondary check, never the only one.
//
//   GET  every page of the route map that has a `pages` row, then the two templates, each
//        with its setting or none (public), and what the edge holds.
//   PUT  one page's or template's setting (packages/schemas/visibility.ts). The person is
//        re-read first (liveRecheck: a demoted Developer's next save is a 403 now, not at the
//        token's expiry); then the save (insert at version 0, else versioned, 409 when
//        someone saved first); then the whole snapshot is rebuilt into KV, and the answer
//        says whether the edge took it (`kvSynced`).
//
// With releases on for the caller's tenant (Admin v2 R14b) both stage instead, as every other
// release-managed route does: GET answers each item's live setting with its pending change
// (`pending`, and `draftsInvalid`, the list's release-mode mark), and PUT, after the same live
// recheck, saves the setting as a pending change (src/lib/release/stagedPageVisibility.ts):
// nothing live moves, so nothing is synced or purged; a publish does both (R7). The bodies below
// are the legacy path, unchanged while releases are off but for one flag read per request and
// the PUT's body parsed in the handler (a staged save also names its pending change, which the
// strict schema would refuse), with the same 422.
//
// `purgeTags` is what a Tier A cache has to clear for this change: the page, and the menus,
// the sitemap and llms.txt that list it on every cached page (the page itself is refused by
// the middleware's check before any cache lookup). After the save they are purged through the
// purge seam (Admin v2 R7, src/lib/http/purge.ts), which sends nothing while no cache zone is
// set up (O-3), so the answer is as before.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'maintenance.manage',
  handler: async (ctx) => {
    const { auth, sb } = ctx;
    if (await ctx.releasesEnabled()) {
      const [staged, edge] = await Promise.all([stagedVisibilityList(ctx), edgeVisibilityStatus()]);
      return { ...staged, edge };
    }
    const [list, edge] = await Promise.all([listVisibility(sb, auth), edgeVisibilityStatus()]);
    return { ...list, edge };
  },
});

export const PUT = defineAdminRoute({
  cap: 'maintenance.manage',
  // Parsed in the handler: a staged save also names `draftId`/`draftVersion` and `staged`.
  input: z.unknown(),
  handler: async (ctx) => {
    const { auth, sb, audit } = ctx;
    if (await ctx.releasesEnabled()) {
      await liveRecheck(auth);
      return stagedVisibilityWrite(ctx, ctx.input);
    }
    // Releases off: a save made in release mode is refused, never written live (R12).
    refuseStagedBody(ctx.input, 'page_visibility');
    const input = PageVisibilityWriteSchema.parse(ctx.input);
    await liveRecheck(auth);
    const { row, fields, target } = await saveVisibility(sb, auth, input);
    const sync = await syncVisibilityToEdge(sb, auth);
    const purgeTags = visibilityPurgeTags(
      target.kind === 'page' ? { kind: 'page', slug: target.slug } : target,
    );
    await purgeAfterSave(auth.tenantId, purgeTags, 'visibility');
    // Audited whether or not the edge took it: a `kvSynced: false` row is how "the change was
    // never live" is found later. Field names only.
    audit({
      action: 'page_visibility.update',
      ...(target.kind === 'page'
        ? { entityType: 'page', entityId: target.id }
        : { entityType: 'page_visibility', entityId: String(row['id']) }),
      detail: {
        mode: input.mode,
        fields,
        ...(target.kind === 'page' ? { page: target.slug } : { template: target.template }),
        kvSynced: sync.kvSynced,
      },
    });
    return {
      setting: settingOfRow(row),
      kvSynced: sync.kvSynced,
      purgeTags,
    };
  },
});
