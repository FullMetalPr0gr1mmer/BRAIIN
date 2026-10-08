import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * One head count beside a sidebar link (src/lib/admin/shell.ts): a HEAD request through
 * the caller's RLS-bound client, so no row leaves the database.
 */
export type Counter = (
  sb: SupabaseClient,
  tenantId: string,
) => PromiseLike<{ count: number | null }>;
