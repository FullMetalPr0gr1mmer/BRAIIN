import { ContactSummaryQuerySchema } from '@schemas/crm';
import { defineAdminRoute } from '@/lib/admin/route';
import { readContactSummary } from '@/lib/crm/contactPage';

// The People screen's counts (Admin v2 C6): per stage, starred, the caller's own, expiring
// within 30 days, and contacts with a phone match to check. Counts only, never a contact.
// `crm.contacts`; runs as the caller (public.crm_contact_summary, INVOKER), for the caller's
// tenant, so a role without contacts learns nothing, not even the volume.
//
// A POST for the screen (C6), and a GET with the same answer (Admin v2 C7): the People page
// renders on the server and refuses itself, and the refusal e2e asks each such screen's JSON
// twin with a GET (tests/admin/routes.ts LOCKED_SCREENS). It takes nothing, so nothing a
// person typed ever reaches its address.

export const prerender = false;

export const POST = defineAdminRoute({
  cap: 'crm.contacts',
  input: ContactSummaryQuerySchema,
  handler: async ({ auth, sb }) => readContactSummary(sb, auth.tenantId),
});

export const GET = defineAdminRoute({
  cap: 'crm.contacts',
  input: ContactSummaryQuerySchema,
  handler: async ({ auth, sb }) => readContactSummary(sb, auth.tenantId),
});
