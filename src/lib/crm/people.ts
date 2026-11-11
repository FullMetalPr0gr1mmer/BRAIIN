import type { SupabaseClient } from '@supabase/supabase-js';

// The CRM's directory of people (public.crm_people, 0036: the active lead workers of the
// caller's tenant, display name and role only), read once per request client and tenant
// (Admin v2 C8 review, C8-PERF-1). A lead's page lists whom the lead can go to (leadPage's
// readPeople) and, for crm.tasks holders, whom a task can go to (taskPage's readTaskOwners);
// both came from the same rows, and each read cost a subrequest (README P-15). A failure is
// shared too: null, and each list is then empty.

const READS = new WeakMap<object, Map<string, Promise<Record<string, unknown>[] | null>>>();

export function crmPeople(
  sb: SupabaseClient,
  tenantId: string,
): Promise<Record<string, unknown>[] | null> {
  let byTenant = READS.get(sb);
  if (!byTenant) {
    byTenant = new Map();
    READS.set(sb, byTenant);
  }
  let read = byTenant.get(tenantId);
  if (!read) {
    read = Promise.resolve(sb.rpc('crm_people', { p_tenant: tenantId })).then(
      ({ data, error }) =>
        error || !Array.isArray(data)
          ? null
          : (data as unknown[]).filter(
              (row): row is Record<string, unknown> => !!row && typeof row === 'object',
            ),
      () => null,
    );
    byTenant.set(tenantId, read);
  }
  return read;
}
