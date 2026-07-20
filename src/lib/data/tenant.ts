import { serviceClient } from '@/lib/supabase/server';

// THE ANON TENANT FENCE, in one place (CLAUDE.md Pillar 1: "anon tenant_id resolves
// SERVER-SIDE ... never client-chosen").
//
// Both public write paths — createLead() and writeSystemLog() — had their own copy of
// "select the oldest tenant". Identical logic, duplicated, in the two functions that
// decide which tenant an unauthenticated write lands in. That is the wrong thing to have
// two of: the schema is explicitly TENANT-READY (§2), so the day a second tenant row
// exists this rule silently misroutes writes, and it would have to be found and fixed
// twice. Now there is one definition to change.
//
// It is deliberately NOT a general "resolve the tenant" helper: it answers only "which
// tenant does an anonymous public write belong to", and the single-tenant assumption is
// named in the function so it cannot be mistaken for tenant resolution in general.

/**
 * The launch tenant (oldest row) — correct while the platform is SINGLE-TENANT.
 * Returns null when unresolvable; callers must fail the write rather than guess.
 *
 * Takes no client argument: `serviceClient()` is memoised, so this reuses the caller's
 * instance, and threading a typed SupabaseClient through would drag its five generic
 * parameters into every call site for no benefit.
 */
export async function resolveLaunchTenantId(): Promise<string | null> {
  try {
    const { data, error } = await serviceClient()
      .from('tenants')
      .select('id')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const id: unknown = (data as { id?: unknown }).id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}
