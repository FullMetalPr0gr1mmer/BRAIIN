import { defineAdminRoute } from '@/lib/admin/route';
import { PENDING_ANY_CAP, compareDraft } from '@/lib/release/draftEndpoints';

// Compare one pending change with the live site (Admin v2 R12; releases.md §7 "Conflicts"):
// for each column live moved in since the change began, the live value and the change's, as
// text. A read: admitted for any role that reads a release-managed type (the summary's gate),
// then the change's own type is checked, and the rows are read under the person's RLS. Sales
// reads none of it. The rules live in src/lib/release/draftEndpoints.ts.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: PENDING_ANY_CAP[0]!,
  anyCap: PENDING_ANY_CAP,
  access: ['full', 'view', 'meta'],
  handler: (ctx) => compareDraft(ctx, ctx.params['id']),
});
