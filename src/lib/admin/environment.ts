import type { SupabaseClient } from '@supabase/supabase-js';

// The sidebar's environment pill (Admin v2 F8, ui.md §2.2): which database this admin is
// editing, from `public.admin_environment(p_tenant)` (0044) over the deployment marker
// (0016). "Live", "Staging" or "Local"; nothing at all when the database is unmarked or
// the call fails, so the pill never names an environment the marker does not.
//
// Cached per isolate, an answer only: the answer is a property of the database, the same
// for every member, and changes only when the launch runbook marks it, so it is kept ten
// minutes (Workers Free plan: 50 subrequests a request, P-15). "No answer" is never kept:
// the function also answers NULL to a caller who is not live (a token whose account was
// locked a moment ago, as a fifth wrong password does), and caching that would hide the
// pill from every member on the isolate. An unmarked database is asked again on each
// render, which the runbook's marker (§1a) ends.

export type AdminEnvironment = 'production' | 'staging' | 'local';

export const ENVIRONMENT_LABELS: Readonly<Record<AdminEnvironment, string>> = {
  production: 'Live',
  staging: 'Staging',
  local: 'Local',
};

const KNOWN_MS = 10 * 60_000;

let cache: { value: AdminEnvironment; until: number } | null = null;

function parse(value: unknown): AdminEnvironment | null {
  return value === 'production' || value === 'staging' || value === 'local' ? value : null;
}

export async function adminEnvironment(
  sb: SupabaseClient,
  tenantId: string,
  now: number = Date.now(),
): Promise<AdminEnvironment | null> {
  if (cache && cache.until > now) return cache.value;
  let value: AdminEnvironment | null = null;
  try {
    const { data, error } = await sb.rpc('admin_environment', { p_tenant: tenantId });
    if (!error) value = parse(data);
  } catch {
    value = null;
  }
  if (value) cache = { value, until: now + KNOWN_MS };
  return value;
}

/** Tests only: forget the cached answer. */
export function resetEnvironmentCache(): void {
  cache = null;
}
