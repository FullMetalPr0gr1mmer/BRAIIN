import { PublishRequestSchema } from '@schemas/release';
import { defineAdminRoute } from '@/lib/admin/route';
import { PUBLISH_CAP_LABEL, RELEASE_ANY_CAP } from '@/lib/release/caps';
import { handleRelease } from '@/lib/release/endpoints';

// POST /api/admin/releases: publish the selected pending changes now, as one release (Admin v2
// R6; docs/admin-v2/releases.md §4.2). The kernel admits any role that publishes some area
// (`RELEASE_ANY_CAP`); every change is then checked against what it needs, the person is
// re-read live, the selection is checked over the state it leaves, and `public.apply_release`
// applies it in one transaction as the publisher. Its audit row (`release.publish`) is written
// inside that transaction. Releases off: 409 `releases-off`. See src/lib/release/endpoints.ts.

export const prerender = false;

export const POST = defineAdminRoute({
  cap: PUBLISH_CAP_LABEL,
  anyCap: RELEASE_ANY_CAP,
  input: PublishRequestSchema,
  handler: (ctx) => handleRelease(ctx, 'publish'),
});
