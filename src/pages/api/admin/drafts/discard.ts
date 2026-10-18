import { DiscardRequestSchema } from '@schemas/release';
import { defineAdminRoute } from '@/lib/admin/route';
import { STAGE_ANY_CAP, discardBulk } from '@/lib/release/draftEndpoints';

// Throw several pending changes away (Admin v2 R3b; releases.md §4.8): `{scope: 'mine'}` (the
// unclaimed changes I last saved, of the types I may stage, up to 200 a request) or
// `{items: [{draftId, draftVersion}]}` (all or nothing: 403 naming any I may not stage, 409
// `pending-changed` listing any that moved). One writer call, one audit row naming ids and
// types, never values. The rules live in src/lib/release/draftEndpoints.ts.

export const prerender = false;

export const POST = defineAdminRoute({
  cap: STAGE_ANY_CAP[0]!,
  anyCap: STAGE_ANY_CAP,
  input: DiscardRequestSchema,
  handler: (ctx) => discardBulk(ctx, ctx.input),
});
