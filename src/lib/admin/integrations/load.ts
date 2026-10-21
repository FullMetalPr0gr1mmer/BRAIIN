import type { SupabaseClient } from '@supabase/supabase-js';
import type { IntegrationsRow } from '@schemas/integrations';
import type { AuthContext } from '@/lib/auth/types';
import { integrationsView, type IntegrationsView } from './view';

// The integrations row as the admin reads it (Admin v2 U11): the route's GET
// (src/pages/api/admin/integrations.ts) and the screen's server read select the same columns,
// through the caller's RLS-bound client (Admin + SEO in both layers since 0105). A tenant
// with no row reads the defaults at version 0: the first save creates it (H7).

/** What GET answers and the screen reads: the three public identifiers, never the legacy jsonb. */
export const INTEGRATION_COLUMNS =
  'tenant_id,ga4_measurement_id,search_console_token,calendly_url,version,updated_at';

/** A tenant's values before its first save (and what a first save inserts beside its own). */
export const INTEGRATION_DEFAULTS = {
  ga4_measurement_id: null,
  search_console_token: null,
  calendly_url: null,
} as const;


/** The tenant's row, read as the caller; throws on a refused or failed read. */
export async function loadIntegrations(
  sb: SupabaseClient,
  auth: AuthContext,
): Promise<IntegrationsView> {
  const { data, error } = await sb
    .from('site_integrations')
    .select(INTEGRATION_COLUMNS)
    .eq('tenant_id', auth.tenantId)
    .maybeSingle<IntegrationsRow>();
  if (error) throw new Error(`read site_integrations: ${error.message}`);
  return integrationsView(data);
}
