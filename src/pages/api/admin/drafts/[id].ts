import { defineAdminRoute } from '@/lib/admin/route';
import { STAGE_ANY_CAP, discardOne } from '@/lib/release/draftEndpoints';

// Throw one pending change away (Admin v2 R3b; releases.md §4.8): `DELETE ?version=n`, at the
// version the person saw. A pending create disappears; a pending removal is undone. Admitted
// for any capability that stages something; the draft's own type is then checked (its author
// capabilities, `app.can_author`), and RLS checks it again. Works whatever the release flag:
// throwing a change away never changes the site (edge case 21). The rules live in
// src/lib/release/draftEndpoints.ts.

export const prerender = false;

export const DELETE = defineAdminRoute({
  cap: STAGE_ANY_CAP[0]!,
  anyCap: STAGE_ANY_CAP,
  handler: (ctx) => discardOne(ctx, ctx.params['id']),
});
