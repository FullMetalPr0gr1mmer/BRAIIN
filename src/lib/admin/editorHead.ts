import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { canReadResource } from './editorAccess';
import { RESOURCES } from './resources';

// What an editor page names in its head (Admin v2 U5/U6: a service's or a project's title, a
// discipline's number and card line), read on the server as the caller. RLS lets every CMS
// staff role read draft rows (`app.is_staff()`, 0001/0028), while the API admits a role only
// through the resource's own read gate (its readCaps at its readAccess), so a role the API
// refuses (Developer on services, disciplines and projects) would see a draft's name in the
// head if the page read the row as RLS allows. These two read only for a role that passes the
// resource's gate (canReadResource) and return nothing otherwise: the page keeps its plain
// title, and the island loads through the API, which refuses it. Pages never read these
// tables themselves (tests/lib/servicesArea.spec.ts holds the three pages to that).

type Row = Record<string, unknown>;

/** One row by id (its tenant's), when the role may read the resource; null otherwise. */
export async function readHeadRow(
  sb: SupabaseClient,
  auth: AuthContext,
  resource: string,
  columns: string,
  id: string,
): Promise<Row | null> {
  const config = RESOURCES[resource];
  if (!config || !canReadResource(resource, auth.role)) return null;
  const { data } = await sb
    .from(config.table)
    .select(columns)
    .eq('tenant_id', auth.tenantId)
    .eq('id', id)
    .maybeSingle();
  return (data ?? null) as Row | null;
}

/**
 * Every row of the tenant in the site's order (sort_order, then id), when the role may read
 * the resource; empty otherwise. A discipline's page numbers it by its place among them.
 */
export async function readHeadList(
  sb: SupabaseClient,
  auth: AuthContext,
  resource: string,
  columns: string,
): Promise<Row[]> {
  const config = RESOURCES[resource];
  if (!config || !canReadResource(resource, auth.role)) return [];
  const { data } = await sb
    .from(config.table)
    .select(columns)
    .eq('tenant_id', auth.tenantId)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  return (data ?? []) as unknown as Row[];
}
