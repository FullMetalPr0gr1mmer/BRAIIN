import type { SupabaseClient } from '@supabase/supabase-js';
import { LeadSummaryQuerySchema } from '@schemas/crm';
import { defineAdminRoute } from '@/lib/admin/route';
import { ValidationError } from '@/lib/admin/errors';
import { previousPeriod, readLeadKpis, readPerStage, type LeadKpis } from '@/lib/crm/leadKpis';

// The lead KPIs (Admin v2 C2a; C4a's figures since 0063): counts per stage kind, spam, the
// average first response time, and now in-progress, won value, unread, starred, per-stage
// counts, SLA breaches and the web form's first response, for an optional date range.
// Counts only, never a lead. `leads.manage`; runs as the caller (public.lead_summary), for
// the caller's tenant, so a Content Creator cannot learn the volume. With a whole range
// (`from` and `to`) it reads the previous period of equal length too, for the deltas
// (src/lib/crm/leadKpis.ts): two reads, and without a range only one and no `previous`.

export const prerender = false;

async function summary(
  sb: SupabaseClient,
  tenantId: string,
  filter: Record<string, unknown>,
): Promise<unknown> {
  const { data, error } = await sb.rpc('lead_summary', { p_tenant: tenantId, p_filter: filter });
  if (error) {
    if (error.code === '22023') throw new ValidationError('summary filter refused');
    throw new Error(`lead_summary: ${error.message}`);
  }
  return data;
}

export const POST = defineAdminRoute({
  cap: 'leads.manage',
  input: LeadSummaryQuerySchema,
  handler: async ({ auth, sb, input }) => {
    const filter: Record<string, unknown> = {};
    if (input.from) filter['from'] = input.from;
    if (input.to) filter['to'] = input.to;
    const before = input.from && input.to ? previousPeriod(input.from, input.to) : null;
    const [current, earlier] = await Promise.all([
      summary(sb, auth.tenantId, filter),
      before ? summary(sb, auth.tenantId, before) : Promise.resolve(null),
    ]);
    const previous: LeadKpis | null = before ? readLeadKpis(earlier) : null;
    return { ...readLeadKpis(current), per_stage: readPerStage(current), previous };
  },
});
