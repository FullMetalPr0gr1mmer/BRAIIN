import { LeadManualCreateSchema } from '@schemas/crm';
import { assertCap } from '@/lib/authz/matrix';
import { defineAdminRoute, json } from '@/lib/admin/route';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { claimPrivilegedOp, MANUAL_LEAD_LIMITS } from '@/lib/admin/rateLimit';
import { addManualLead } from '@/lib/crm/manualLead';

// /api/admin/leads: adding a lead by hand (POST). The legacy panel's list, a GET here, went in
// Admin v2 C14a: the CRM reads leads through POST /api/admin/leads/query (public.leads_list,
// RLS, the live check and the column grants decide), its search in a body, never the address.
// A GET here finds no handler (Astro answers 404; signed out, the middleware's 401 comes first).

export const prerender = false;

// Adding a lead by hand (Admin v2 C3, crm.md §7.2): `leads.manage` AND `leads.pii`, since
// it writes a person's contact details, then a live recheck, because the lead is written
// as the service role (no staff token inserts leads, 0030), then a limit of 60 an hour per
// person and 300 per tenant (MANUAL_LEAD_LIMITS, fail-closed), claimed before any lookup.
// The lead goes through the same door as the public form, public.crm_ingest_lead, with
// `source` 'manual' and the adding person set here, never by the client. A phone that matches an earlier lead while the
// e-mail does not is answered with a 409 and the matches (safe fields only), unless the
// caller sends `createNew`; an e-mail match is added and named in the answer. Both answers
// are audited: `lead.create`, or `lead.create.duplicate` with the matched leads' ids (never
// the e-mail, phone or name typed).
export const POST = defineAdminRoute({
  cap: 'leads.manage',
  input: LeadManualCreateSchema,
  handler: async ({ auth, sb, input, audit }) => {
    assertCap(auth, 'leads.pii');
    await liveRecheck(auth);
    await claimPrivilegedOp(auth, 'lead-manual-add', MANUAL_LEAD_LIMITS);

    const outcome = await addManualLead(auth, sb, input);
    if (outcome.kind === 'possible-duplicate') {
      // Nothing was added, but the lookup was made: ids only.
      audit({
        action: 'lead.create.duplicate',
        entityType: 'lead',
        detail: {
          source: 'manual',
          channel: input.channel,
          matches: outcome.matches.map((lead) => lead.id),
        },
      });
      return json({ ok: false, error: 'possible-duplicate', matches: outcome.matches }, 409);
    }

    // The source and the channel; never the person's details.
    audit({
      action: 'lead.create',
      entityType: 'lead',
      entityId: outcome.id,
      detail: {
        source: 'manual',
        channel: input.channel,
        sameEmailAs: outcome.sameEmail.map((lead) => lead.id),
      },
    });
    return { id: outcome.id, sameEmail: outcome.sameEmail };
  },
});
