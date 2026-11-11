import type { SupabaseClient } from '@supabase/supabase-js';

// The sidebar's two CRM counts in one read (Admin v2 C8): new leads and my overdue tasks, from
// public.crm_nav_counts (0134, SECURITY INVOKER: RLS and the live check decide). A Worker
// request makes at most 50 subrequests on the Workers Free plan (README P-15), and the
// dashboard, the heaviest admin page, sits at its measured budget
// (tests/lib/dashboardWidgets.spec.ts): the Tasks badge would have been one more read there.
// Read once per request client and tenant, whichever counter asks first; a failure is shared
// too, and each counter then shows no count (never zero).

export interface CrmCounts {
  leads: number | null;
  tasks: number | null;
}

const READS = new WeakMap<object, Map<string, Promise<CrmCounts>>>();

const countOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export function crmCounts(sb: SupabaseClient, tenantId: string): Promise<CrmCounts> {
  let byTenant = READS.get(sb);
  if (!byTenant) {
    byTenant = new Map();
    READS.set(sb, byTenant);
  }
  let read = byTenant.get(tenantId);
  if (!read) {
    read = Promise.resolve(sb.rpc('crm_nav_counts', { p_tenant: tenantId })).then(
      ({ data, error }) => {
        if (error || !data || typeof data !== 'object') return { leads: null, tasks: null };
        const row = data as Record<string, unknown>;
        return { leads: countOf(row['leads']), tasks: countOf(row['tasks']) };
      },
      () => ({ leads: null, tasks: null }),
    );
    byTenant.set(tenantId, read);
  }
  return read;
}
