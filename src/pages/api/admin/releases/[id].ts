import { defineAdminRoute } from '@/lib/admin/route';
import { PENDING_ANY_CAP } from '@/lib/release/draftEndpoints';
import { versionDetail } from '@/lib/release/versions';

// GET /api/admin/releases/[id]: one site version's changes (Admin v2 R10; releases.md §6.1).
// Any CMS role that reads a release-managed area passes the gate; each change is then listed
// only when the person reads its area (the others are counted), with before and after for plain
// and bilingual fields. Read under the person's RLS (the ledger is CMS staff's, 0038). The rules
// live in src/lib/release/versions.ts.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: PENDING_ANY_CAP[0]!,
  anyCap: PENDING_ANY_CAP,
  access: ['full', 'view', 'meta'],
  handler: (ctx) => versionDetail(ctx),
});
