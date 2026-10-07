import { LeadSummaryQuerySchema } from '@schemas/crm';
import { defineAdminRoute } from '@/lib/admin/route';
import { ValidationError } from '@/lib/admin/errors';

// The lead KPIs (Admin v2 C2a): counts per stage kind, spam, and the average first
// response time, for an optional date range. Counts only, never a lead. `leads.manage`;
// runs as the caller (public.lead_summary), for the caller's tenant, so a Content Creator
// cannot learn the volume.

export const prerender = false;

const COUNT_KEYS = ['total', 'new', 'open', 'won', 'lost', 'spam'] as const;

export const POST = defineAdminRoute({
  cap: 'leads.manage',
  input: LeadSummaryQuerySchema,
  handler: async ({ auth, sb, input }) => {
    const filter: Record<string, unknown> = {};
    if (input.from) filter['from'] = input.from;
    if (input.to) filter['to'] = input.to;
    const { data, error } = await sb.rpc('lead_summary', {
      p_tenant: auth.tenantId,
      p_filter: filter,
    });
    if (error) {
      if (error.code === '22023') throw new ValidationError('summary filter refused');
      throw new Error(`lead_summary: ${error.message}`);
    }
    const kpis = (data ?? {}) as Record<string, unknown>;
    const out: Record<string, number | null> = {};
    for (const key of COUNT_KEYS) out[key] = Number(kpis[key] ?? 0);
    // No response yet is "no data", not zero hours.
    const hours = kpis['avg_first_response_hours'];
    out['avg_first_response_hours'] = hours === null || hours === undefined ? null : Number(hours);
    return out;
  },
});
