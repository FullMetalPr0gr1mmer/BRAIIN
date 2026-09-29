import type { SupabaseClient } from '@supabase/supabase-js';
// Worker bindings come from the runtime module (Astro 6+ removed `locals.runtime.env`),
// exactly as src/pages/api/admin/settings/maintenance.ts reaches KV.
import { env } from 'cloudflare:workers';
import type { AuthContext } from '@/lib/auth/types';
import {
  REDIRECTS_KV_KEY,
  REDIRECT_MAP_LIMIT,
  buildRedirectMap,
  parseRedirectMap,
  putRedirectMap,
} from '@/lib/http/redirects';
import { writeSystemLog } from '@/lib/data/systemLog';

// Snapshot on write (design-port R3-1): every redirect save or delete rebuilds the
// tenant's WHOLE map from the table and writes it to KV. Rebuilding rather than patching
// one key keeps the snapshot a pure function of the table — there is no partial state
// to get wrong, and the "Sync to edge" button is the same function run by hand for a
// backfill or after a KV failure.

export interface RedirectSyncResult {
  /** Whether KV took the snapshot. False means: saved to the database, edge unchanged. */
  kvSynced: boolean;
  /** Rules in the snapshot (after normalisation — reserved sources and duplicates dropped). */
  count: number;
  /** The table holds more rows than the snapshot carries (REDIRECT_MAP_LIMIT). */
  truncated: boolean;
}

/**
 * Reads the tenant's rules under the caller's RLS-bound client (never the service role:
 * a caller who may not read redirects may not snapshot them either), builds the map and
 * writes it. NEVER throws — it runs inside the kernel's after-write hook, where a throw
 * would be reported as a failed save of a row that is already committed.
 *
 * Not `listRows`: that helper caps a page at 100 and this needs the whole set; the
 * tenant predicate is stated explicitly here for the same reason crud.ts states it.
 */
export async function syncRedirectsToEdge(
  sb: SupabaseClient,
  auth: AuthContext,
): Promise<RedirectSyncResult> {
  try {
    const { data, error } = await sb
      .from('redirects')
      .select('source_path,target_path,status')
      .eq('tenant_id', auth.tenantId)
      .order('source_path', { ascending: true })
      .limit(REDIRECT_MAP_LIMIT);
    if (error) throw new Error(`read redirects: ${error.message}`);
    const rows = (data ?? []) as { source_path: unknown; target_path: unknown; status?: unknown }[];
    const map = buildRedirectMap(rows);
    const kvSynced = await putRedirectMap(env, map);
    return {
      kvSynced,
      count: Object.keys(map).length,
      truncated: rows.length >= REDIRECT_MAP_LIMIT,
    };
  } catch (err) {
    void writeSystemLog({
      level: 'error',
      source: 'admin:redirect.sync',
      message: err instanceof Error ? err.message : 'redirect sync failed',
      detail: { tenantId: auth.tenantId },
    });
    return { kvSynced: false, count: 0, truncated: false };
  }
}

/**
 * How many rules the edge currently holds, for the status line beside "Sync to edge" —
 * read WITHOUT the middleware's cacheTtl so the number an operator sees is the one just
 * written, not a minute-old copy. `null` when KV is unbound or unreadable.
 */
export async function edgeRedirectCount(): Promise<number | null> {
  try {
    const raw = await env.SESSION?.get(REDIRECTS_KV_KEY);
    if (raw === null || raw === undefined) return null;
    return Object.keys(parseRedirectMap(raw)).length;
  } catch {
    return null;
  }
}
