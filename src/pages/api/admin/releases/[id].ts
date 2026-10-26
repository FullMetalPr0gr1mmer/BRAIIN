import { RescheduleRequestSchema } from '@schemas/release';
import { defineAdminRoute } from '@/lib/admin/route';
import { PUBLISH_CAP_LABEL, RELEASE_ANY_CAP } from '@/lib/release/caps';
import { PENDING_ANY_CAP } from '@/lib/release/draftEndpoints';
import { rescheduleRelease, unscheduleRelease } from '@/lib/release/schedule';
import { versionDetail } from '@/lib/release/versions';

// GET /api/admin/releases/[id]: one site version's changes (Admin v2 R10; releases.md §6.1).
// Any CMS role that reads a release-managed area passes the gate; each change is then listed
// only when the person reads its area (the others are counted), with before and after for plain
// and bilingual fields. Read under the person's RLS (the ledger is CMS staff's, 0038). The rules
// live in src/lib/release/versions.ts.
//
// PATCH (`{version, scheduleAt}`) moves a scheduled release, DELETE (`?version=n`) cancels it
// (Admin v2 R11; releases.md §4.7): admitted for any role that publishes some area, then every
// change it holds must be the person's to publish, the person is re-read live, and the database
// checks both again and audits. Releases off: 409 `releases-off`. The rules live in
// src/lib/release/schedule.ts.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: PENDING_ANY_CAP[0]!,
  anyCap: PENDING_ANY_CAP,
  access: ['full', 'view', 'meta'],
  handler: (ctx) => versionDetail(ctx),
});

export const PATCH = defineAdminRoute({
  cap: PUBLISH_CAP_LABEL,
  anyCap: RELEASE_ANY_CAP,
  input: RescheduleRequestSchema,
  handler: (ctx) => rescheduleRelease(ctx),
});

export const DELETE = defineAdminRoute({
  cap: PUBLISH_CAP_LABEL,
  anyCap: RELEASE_ANY_CAP,
  handler: (ctx) => unscheduleRelease(ctx),
});
