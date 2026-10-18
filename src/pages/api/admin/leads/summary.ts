import { LeadSummaryQuerySchema } from '@schemas/crm';
import { defineAdminRoute } from '@/lib/admin/route';
import { readLeadSummary } from '@/lib/crm/leadReads';

// The lead KPIs (Admin v2 C2a; C4a's figures since 0063): counts per stage kind, spam, the
// average first response time, and now in-progress, won value, unread, starred, per-stage
// counts, SLA breaches and the web form's first response, for an optional date range.
// Counts only, never a lead. `leads.manage`; runs as the caller (public.lead_summary), for
// the caller's tenant, so a Content Creator cannot learn the volume. With a whole range
// (`from` and `to`) it reads the same elapsed span before it too, for the deltas
// (src/lib/crm/leadKpis.ts): two reads, and without a range only one and no `previous`.

export const prerender = false;

export const POST = defineAdminRoute({
  cap: 'leads.manage',
  input: LeadSummaryQuerySchema,
  // The reads are shared with the leads page's first view (src/lib/crm/leadReads.ts).
  handler: async ({ auth, sb, input }) => readLeadSummary(sb, auth.tenantId, input),
});
