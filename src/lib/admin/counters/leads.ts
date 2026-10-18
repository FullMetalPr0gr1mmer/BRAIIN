import type { Counter } from './types';

// New leads, beside Leads: the leads still in the pipeline's first stage, spam left out (Admin
// v2 C4a). The same rule as the dashboard's "New leads waiting" (public.lead_summary's `new`,
// 0036), so a badge and a card never disagree; before C4a it counted the legacy
// `status = 'new'`. One HEAD request: the stage is joined through the composite key
// (tenant_id, stage_id) → lead_stages (tenant_id, id), the only relation between the two
// tables, and the caller's client reads both (RLS and the live check decide which leads).
export const leads: Counter = (sb, tenantId) =>
  sb
    .from('leads')
    .select('id,lead_stages!inner(is_initial)', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('is_spam', false)
    .eq('lead_stages.is_initial', true);
