import { RestoreVersionRequestSchema } from '@schemas/release';
import { defineAdminRoute } from '@/lib/admin/route';
import { PUBLISH_CAP_LABEL, RELEASE_ANY_CAP } from '@/lib/release/caps';
import { restoreVersion } from '@/lib/release/restore';

// POST /api/admin/releases/[id]/restore: stage the site (or, with `pageId`, one page and its
// sections) as it was at that version, as pending changes to preview and publish (Admin v2 R10;
// releases.md A3-8, §6.2). Never a live write: the changes go through `write_drafts` under the
// person's RLS and are published through the same path as any other, as a rollback. The kernel
// admits a role that publishes some area; every staged change is then checked against what its
// publish needs (Admin and the publishers only, P-2). Releases off: 409 `releases-off`. See
// src/lib/release/restore.ts.

export const prerender = false;

export const POST = defineAdminRoute({
  cap: PUBLISH_CAP_LABEL,
  anyCap: RELEASE_ANY_CAP,
  input: RestoreVersionRequestSchema,
  handler: (ctx) => restoreVersion(ctx),
});
