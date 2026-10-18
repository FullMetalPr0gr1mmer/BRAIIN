import { LEAD_PII_ENC_KEY } from 'astro:env/server';
import { LeadQuerySchema } from '@schemas/crm';
import { defineAdminRoute } from '@/lib/admin/route';
import { tenantCountry, toRpcFilter } from '@/lib/crm/leadQuery';
import { readLeadList } from '@/lib/crm/leadReads';

// The lead list (Admin v2 C2a): `leads.manage`. A POST, so the search never sits in a URL,
// a log line or the browser history (verification D9/D10). The filter runs as the caller
// through public.leads_list (SECURITY INVOKER) for the caller's tenant: RLS, the live check
// and the column grants decide what comes back, and the rows are cut to the safe fields
// again here (LEAD_LIST_FIELDS: since C4a, 0063, the assignee, value, star, read mark, last
// logged contact and the SLA flag too; never tags or the score's reasons). The total is counted apart from the page, so a page past the end still says
// how many leads match.

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
    // The read and its shaping are shared with the leads page's first view (leadReads.ts).
    const { rows, total } = await readLeadList(sb, auth.tenantId, filter);
    return {
      rows,
      total,
      limit: input.limit ?? 25,
      offset: input.offset ?? 0,
    };
  },
});
