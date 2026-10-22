import { PublishRequestSchema, VersionsQuerySchema } from '@schemas/release';
import { defineAdminRoute } from '@/lib/admin/route';
import { PUBLISH_CAP_LABEL, RELEASE_ANY_CAP } from '@/lib/release/caps';
import { PENDING_ANY_CAP } from '@/lib/release/draftEndpoints';
import { handleRelease } from '@/lib/release/endpoints';
import { listVersions } from '@/lib/release/versions';

// POST /api/admin/releases: publish the selected pending changes now, as one release (Admin v2
// R6; docs/admin-v2/releases.md §4.2). The kernel admits any role that publishes some area
// (`RELEASE_ANY_CAP`); every change is then checked against what it needs, the person is
// re-read live, the selection is checked over the state it leaves, and `public.apply_release`
// applies it in one transaction as the publisher. Its audit row (`release.publish`) is written
// inside that transaction. Releases off: 409 `releases-off`. See src/lib/release/endpoints.ts.
// With `kind: 'rollback'` (R10) every change must be a restore of one version, which the release
// then names (restores_release_id, default note "Restored vN").
//
// GET /api/admin/releases: the site's numbered versions, newest first, with what is scheduled
// or failed on top (Admin v2 R10; releases.md §6.1). Any CMS role that reads a release-managed
// area; read under the person's RLS. Releases off: an empty list and `enabled: false`. See
// src/lib/release/versions.ts.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: PENDING_ANY_CAP[0]!,
  anyCap: PENDING_ANY_CAP,
  access: ['full', 'view', 'meta'],
  input: VersionsQuerySchema,
  handler: (ctx) => listVersions(ctx, ctx.input.before),
});

export const POST = defineAdminRoute({
  cap: PUBLISH_CAP_LABEL,
  anyCap: RELEASE_ANY_CAP,
  input: PublishRequestSchema,
  handler: (ctx) => handleRelease(ctx, 'publish'),
});
