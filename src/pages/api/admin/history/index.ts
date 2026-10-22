import { HistoryQuerySchema } from '@schemas/release';
import { defineAdminRoute } from '@/lib/admin/route';
import { PENDING_ANY_CAP } from '@/lib/release/draftEndpoints';
import { entityHistory } from '@/lib/release/history';

// GET /api/admin/history?entityType&entityId[&scope=page][&before=n]: one entity's numbered
// history (Admin v2 R10; releases.md §6.2): its snapshots newest first with the version that
// made each, whether it is live or was removed, and its pending change; for a page, every site
// version that changed it or its sections. The person must read the entity's area. Read under
// the person's RLS. See src/lib/release/history.ts.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: PENDING_ANY_CAP[0]!,
  anyCap: PENDING_ANY_CAP,
  access: ['full', 'view', 'meta'],
  input: HistoryQuerySchema,
  handler: (ctx) => entityHistory(ctx),
});
