import { LEAD_PII_ENC_KEY } from 'astro:env/server';
import { LeadQuerySchema } from '@schemas/crm';
import { defineAdminRoute } from '@/lib/admin/route';
import { ValidationError } from '@/lib/admin/errors';
import { LEAD_LIST_FIELDS, pick, tenantCountry, toRpcFilter } from '@/lib/crm/leadQuery';
import { resolveLeadInterests, withInterestLabels } from '@/lib/leads/interestLabel';

// The lead list (Admin v2 C2a): `leads.manage`. A POST, so the search never sits in a URL,
// a log line or the browser history (verification D9/D10). The filter runs as the caller
// through public.leads_list (SECURITY INVOKER): RLS, the live check and the column grants
// decide what comes back, and the rows are cut to the safe fields again here.

export const prerender = false;

export const POST = defineAdminRoute({
  cap: 'leads.manage',
  input: LeadQuerySchema,
  handler: async ({ auth, sb, input }) => {
    const filter = await toRpcFilter(
      LEAD_PII_ENC_KEY,
      auth.tenantId,
      input,
      tenantCountry(sb, auth.tenantId),
    );
    const { data, error } = await sb.rpc('leads_list', { p_filter: filter });
    if (error) {
      if (error.code === '22023') throw new ValidationError('lead filter refused');
      throw new Error(`leads_list: ${error.message}`);
    }
    const found = (data ?? []) as Record<string, unknown>[];
    const total = Number(found[0]?.['total'] ?? 0);
    const rows = found.map((row) => pick(row, LEAD_LIST_FIELDS));
    const labels = await resolveLeadInterests(sb, auth.tenantId, rows);
    return {
      rows: rows.map((row) => withInterestLabels(row, labels)),
      total,
      limit: input.limit ?? 25,
      offset: input.offset ?? 0,
    };
  },
});
