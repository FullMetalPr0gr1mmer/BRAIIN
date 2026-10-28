import { env } from 'cloudflare:workers';
import { defineAdminRoute } from '@/lib/admin/route';
import { getMaintenanceState } from '@/lib/http/maintenance';
import { PENDING_ANY_CAP } from '@/lib/release/draftEndpoints';
import { releaseStatus } from '@/lib/release/status';

// GET /api/admin/releases/status: the dashboard's "Publish status" card (Admin v2 R13;
// releases.md §7): the live version and its cache purge, the pending changes as the savebar
// counts them, the next scheduled release, failed ones, whether a cache is connected, and
// maintenance. Any CMS role that reads a release-managed area (the pending summary's gate),
// never Sales; read under the person's RLS. Releases off: `enabled: false` and nothing else is
// read. See src/lib/release/status.ts.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: PENDING_ANY_CAP[0]!,
  anyCap: PENDING_ANY_CAP,
  access: ['full', 'view', 'meta'],
  handler: (ctx) => releaseStatus(ctx, async () => (await getMaintenanceState(env)).active),
});
