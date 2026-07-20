import { SystemLogEntrySchema, type SystemLogEntry } from '@schemas/systemLog';
import { serviceClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/supabase/client';

// Operational log sink → public.system_logs (CLAUDE.md §10). RLS restricts INSERT to
// staff, so anonymous client errors are written with the SERVICE-ROLE client and the
// tenant resolved SERVER-SIDE (the anon fence — never client-supplied), mirroring
// createLead(). Separate from audit_log, which is append-only + hash-chained.
//
// NEVER throws: logging must not break the request that produced the log line. Returns
// false when unconfigured or on any failure, so callers can stay fire-and-forget.

export type { SystemLogEntry };

export async function writeSystemLog(entry: SystemLogEntry): Promise<boolean> {
  if (!supabaseConfigured()) return false;
  // Validate at the sink, not only at the endpoint: this is an exported server-side
  // function and the caps (message ≤2000, source ≤120) are what stop an error-path loop
  // from flooding an append-only table.
  const parsed = SystemLogEntrySchema.safeParse(entry);
  if (!parsed.success) return false;
  const valid = parsed.data;
  try {
    const sb = serviceClient();

    // Resolve the single launch tenant server-side (the fence).
    const { data: tenant } = await sb
      .from('tenants')
      .select('id')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!tenant) return false;

    const { error } = await sb.from('system_logs').insert({
      tenant_id: tenant.id,
      level: valid.level,
      source: valid.source ?? null,
      message: valid.message,
      detail: valid.detail ?? {},
    });
    return !error;
  } catch {
    return false;
  }
}
