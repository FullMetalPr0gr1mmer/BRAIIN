import type { Counter } from './types';
import { crmCounts } from './crm';

// New leads, beside Leads: the leads still in the pipeline's first stage, spam left out (Admin
// v2 C4a). The same rule as the dashboard's "New leads waiting" (public.lead_summary's `new`,
// 0036), so a badge and a card never disagree; before C4a it counted the legacy
// `status = 'new'`. Since Admin v2 C8 it is read with the Tasks badge in one request
// (public.crm_nav_counts, ./crm.ts), which counts the same way: the stage joined through the
// composite key (tenant_id, stage_id), as the caller (RLS and the live check decide).
export const leads: Counter = (sb, tenantId) =>
  crmCounts(sb, tenantId).then((counts) => ({ count: counts.leads }));
