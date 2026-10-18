import { ResolveRequestSchema } from '@schemas/release';
import { defineAdminRoute } from '@/lib/admin/route';
import { STAGE_ANY_CAP, resolveDraft } from '@/lib/release/draftEndpoints';

// Settle a conflict on one pending change (Admin v2 R3b; releases.md §4.5): per column, "Keep
// mine" or "Use the live version", at the version the person saw. Admitted for any capability
// that stages something; the change itself is then checked against what publishing it needs
// (an archive needs `content.archiveDelete`), and RLS checks the rewrite again. The rules live
// in src/lib/release/draftEndpoints.ts.

export const prerender = false;

export const POST = defineAdminRoute({
  cap: STAGE_ANY_CAP[0]!,
  anyCap: STAGE_ANY_CAP,
  input: ResolveRequestSchema,
  handler: (ctx) => resolveDraft(ctx, ctx.params['id'], ctx.input),
});
