import { defineAdminRoute } from '@/lib/admin/route';
import { PUBLISH_CAP_LABEL, RELEASE_ANY_CAP } from '@/lib/release/caps';
import { retryPurge } from '@/lib/release/purgeRetry';

// POST /api/admin/releases/[id]/purge: send a published version's cache purge again, by hand
// (Admin v2 R13; releases.md §7 "Couldn't refresh · Retry"; owed by R7 and R10). Any role that
// publishes some area; the version must be the tenant's, published and its purge failed. One
// request through the purge seam (src/lib/http/purge.ts), recorded on the version and audited
// (`release.purge`). Releases off: 409 `releases-off`. See src/lib/release/purgeRetry.ts.

export const prerender = false;

export const POST = defineAdminRoute({
  cap: PUBLISH_CAP_LABEL,
  anyCap: RELEASE_ANY_CAP,
  handler: (ctx) => retryPurge(ctx),
});
