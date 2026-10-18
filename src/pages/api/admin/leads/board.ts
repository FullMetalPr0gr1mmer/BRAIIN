import { LEAD_PII_ENC_KEY } from 'astro:env/server';
import { LeadBoardQuerySchema } from '@schemas/crm';
import { defineAdminRoute } from '@/lib/admin/route';
import { tenantCountry, toRpcFilter } from '@/lib/crm/leadQuery';
import { readLeadBoard } from '@/lib/crm/leadReads';

// The pipeline board (Admin v2 C2a): every stage of the caller's tenant with its count, its
// value in SAR (C4a, 0063: the matching non-spam leads' value_sar; the screen shows it on won
// columns) and newest cards, spam excluded. Filters by assignee, source, channel and
// discipline since 0063. `leads.manage`; runs as the caller (public.leads_board), for the
// caller's tenant.

export const prerender = false;

export const POST = defineAdminRoute({
  cap: 'leads.manage',
  input: LeadBoardQuerySchema,
  handler: async ({ auth, sb, input }) => {
    const filter = await toRpcFilter(
      LEAD_PII_ENC_KEY,
      auth.tenantId,
      input,
      tenantCountry(sb, auth.tenantId),
    );
    // The read and its shaping are shared with the board page's first view (leadReads.ts).
    return { columns: await readLeadBoard(sb, auth.tenantId, filter) };
  },
});
