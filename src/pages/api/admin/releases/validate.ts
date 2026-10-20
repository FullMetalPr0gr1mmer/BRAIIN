import { PublishRequestSchema } from '@schemas/release';
import { defineAdminRoute } from '@/lib/admin/route';
import { PUBLISH_CAP_LABEL, RELEASE_ANY_CAP } from '@/lib/release/caps';
import { handleRelease } from '@/lib/release/endpoints';

// POST /api/admin/releases/validate: the publish dialog's check (Admin v2 R6; docs/admin-v2/
// releases.md §4.3). The same steps as publishing, then, when the Worker finds nothing to fix,
// `public.apply_release` in dry-run mode, which applies everything as the publisher and undoes
// it (no row, no version number kept), so the dialog shows what the database would refuse
// (CHECKs, guards, RESTRICTIVE policies) and any conflict with live. Answers a ReleaseCheck.
// Nothing is written and nothing is audited. Releases off: 409 `releases-off`.

export const prerender = false;

export const POST = defineAdminRoute({
  cap: PUBLISH_CAP_LABEL,
  anyCap: RELEASE_ANY_CAP,
  input: PublishRequestSchema,
  handler: (ctx) => handleRelease(ctx, 'validate'),
});
