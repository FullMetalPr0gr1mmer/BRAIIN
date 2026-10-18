import { defineAdminRoute } from '@/lib/admin/route';
import { PENDING_ANY_CAP, pendingSummary } from '@/lib/release/draftEndpoints';

// The pending summary (Admin v2 R3b; releases.md §3): every unpublished change the caller may
// read, with who can publish it (`publishableByMe`, `requiredCaps`, `waitingFor`) and counts by
// area, for the savebar and the publish dialog (R12, R13). Any CMS role that reads a
// release-managed type passes the gate; the list is then filtered by each type's read
// capabilities. Stored metadata only: nothing here re-parses a payload. The rules live in
// src/lib/release/draftEndpoints.ts.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: PENDING_ANY_CAP[0]!,
  anyCap: PENDING_ANY_CAP,
  access: ['full', 'view', 'meta'],
  handler: (ctx) => pendingSummary(ctx),
});
