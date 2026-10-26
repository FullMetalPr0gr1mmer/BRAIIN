import { defineAdminRoute } from '@/lib/admin/route';
import { readLeadInterestCounts } from '@/lib/crm/leadInterest';

// GET /api/admin/leads/interest-counts (Admin v2 U5, AV-14): how many inquiries named each
// service, `{ counts: { "<service slug>": n } }`, for the discipline page's "N leads" badges
// and "Leads by service" chart. Counts only, never a lead. `leads.manage` (the leads caps:
// Admin, Developer, Sales; Content Creator and SEO are refused here, and the screen asks only
// when the role holds it). Runs as the caller (public.lead_interest_counts, 0111, SECURITY
// INVOKER) for the caller's tenant, so RLS and the live check count what the person may see.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'leads.manage',
  handler: async ({ auth, sb }) => ({ counts: await readLeadInterestCounts(sb, auth.tenantId) }),
});
