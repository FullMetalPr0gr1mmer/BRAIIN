import type { SupabaseClient } from '@supabase/supabase-js';

// How many inquiries named each service (Admin v2 U5): the discipline page's "N leads" badges
// and its "Leads by service" chart, and the count beside a service's Leads tab. One read of
// public.lead_interest_counts (0111), which runs as the caller (SECURITY INVOKER): leads' RLS,
// the RESTRICTIVE live check and the column grant decide what it counts, for the caller's
// own tenant only. Counts only: no lead's id, name or words ever leave the database here.
//
// What comes back is cut to its shape again: a key that is a service slug, a value that is a
// whole number of zero or more. Anything else is dropped, never passed on.

/** A service slug as the services table holds it (0001's SlugSchema: lower case and hyphens). */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The counts by service slug, cut to their shape. */
export function cleanInterestCounts(data: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) return out;
  for (const [slug, value] of Object.entries(data as Record<string, unknown>)) {
    if (!SLUG.test(slug) || slug.length > 120) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) continue;
    out[slug] = value;
  }
  return out;
}

/** public.lead_interest_counts for the caller's tenant, as the caller. */
export async function readLeadInterestCounts(
  sb: SupabaseClient,
  tenantId: string,
): Promise<Record<string, number>> {
  const { data, error } = await sb.rpc('lead_interest_counts', { p_tenant: tenantId });
  if (error) throw new Error(`lead_interest_counts: ${error.code ?? error.message}`);
  return cleanInterestCounts(data);
}
