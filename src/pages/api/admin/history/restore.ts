import { HistoryRestoreRequestSchema } from '@schemas/release';
import { defineAdminRoute } from '@/lib/admin/route';
import { PUBLISH_CAP_LABEL, RELEASE_ANY_CAP } from '@/lib/release/caps';
import { restoreSnapshot } from '@/lib/release/restore';

// POST /api/admin/history/restore: stage one entity as one of its numbered snapshots was, as a
// pending change (Admin v2 R10; releases.md §6.2 "Per-item restore"). The same rules as restoring
// a version: never a live write, refused when the entity has a pending change, when the person
// cannot publish the change (P-2) or when the snapshot cannot come back as it was. Releases off:
// 409 `releases-off`. See src/lib/release/restore.ts.

export const prerender = false;

export const POST = defineAdminRoute({
  cap: PUBLISH_CAP_LABEL,
  anyCap: RELEASE_ANY_CAP,
  input: HistoryRestoreRequestSchema,
  handler: (ctx) => restoreSnapshot(ctx),
});
