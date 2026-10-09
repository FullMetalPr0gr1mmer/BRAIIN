import { LeadListQuerySchema } from '@schemas/admin';
import { LeadManualCreateSchema } from '@schemas/crm';
import { assertCap } from '@/lib/authz/matrix';
import { defineAdminRoute, json } from '@/lib/admin/route';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { addManualLead } from '@/lib/crm/manualLead';
import { listRows } from '@/lib/admin/crud';
import { SAFE_LEAD_COLUMNS, stripSensitive } from '@/lib/admin/leadFields';
import { resolveLeadInterests, withInterestLabels } from '@/lib/leads/interestLabel';

// Lead list — `leads.manage` (Admin + Developer). Content Creator and SEO hold `none`
// and are refused by assertCap before a query is built.
//
// The LIST always projects the safe columns, even for a caller who holds `leads.pii`.
// PII is fetched one lead at a time through `[id]`, which audits the view. A list that
// decrypted every row would produce one audit entry ("listed leads") covering fifty
// people's phone numbers, which is not the record PDPL Article-level accountability
// wants — and it would decrypt fifty payloads to render a table showing names.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'leads.manage',
  input: LeadListQuerySchema,
  handler: async ({ auth, sb, input }) => {
    const { rows, total } = await listRows<Record<string, unknown>>(sb, 'leads', auth, {
      columns: SAFE_LEAD_COLUMNS,
      orderBy: { column: 'created_at', ascending: false },
      filters: input.status ? { status: input.status } : {},
      search: input.q ? { column: 'name', term: input.q } : undefined,
      limit: input.limit,
      offset: input.offset,
    });

    // Readable labels for the interest slugs (old or new), resolved once per page under
    // the caller's connection — derived fields, never columns (Round 3).
    const labels = await resolveLeadInterests(sb, auth.tenantId, rows);

    return {
      rows: rows.map((row) => withInterestLabels(stripSensitive(row), labels)),
      total,
      limit: input.limit,
      offset: input.offset,
    };
  },
});

// Adding a lead by hand (Admin v2 C3, crm.md §7.2): `leads.manage` AND `leads.pii`, since
// it writes a person's contact details, then a live recheck, because the lead is written
// as the service role (no API role inserts leads, 0030). The lead goes through the same
// door as the public form, public.crm_ingest_lead, with `source` 'manual' and the adding
// person set here, never by the client. A phone that matches an earlier lead while the
// e-mail does not is answered with a 409 and the matches (safe fields only), unless the
// caller sends `createNew`; an e-mail match is added and named in the answer.
export const POST = defineAdminRoute({
  cap: 'leads.manage',
  input: LeadManualCreateSchema,
  handler: async ({ auth, sb, input, audit }) => {
    assertCap(auth, 'leads.pii');
    await liveRecheck(auth);

    const outcome = await addManualLead(auth, sb, input);
    if (outcome.kind === 'possible-duplicate') {
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
