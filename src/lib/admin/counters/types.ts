import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * One count beside a sidebar link (src/lib/admin/shell.ts), read through the caller's
 * RLS-bound client so no row leaves the database: a HEAD count, or (the Leads and Tasks
 * links, Admin v2 C8) one shared RPC that answers counts only (counters/crm.ts).
 */
export type Counter = (
  sb: SupabaseClient,
  tenantId: string,
) => PromiseLike<{ count: number | null }>;
