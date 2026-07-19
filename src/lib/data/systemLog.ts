import { serviceClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/supabase/client';

// Operational log sink → public.system_logs (CLAUDE.md §10). RLS restricts INSERT to
// staff, so anonymous client errors are written with the SERVICE-ROLE client and the
// tenant resolved SERVER-SIDE (the anon fence — never client-supplied), mirroring
// createLead(). Separate from audit_log, which is append-only + hash-chained.
//
// NEVER throws: logging must not break the request that produced the log line. Returns
// false when unconfigured or on any failure, so callers can stay fire-and-forget.

export interface SystemLogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  source?: string;
  detail?: Record<string, unknown>;
}

export async function writeSystemLog(entry: SystemLogEntry): Promise<boolean> {
  if (!supabaseConfigured()) return false;
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
      level: entry.level,
      source: entry.source ?? null,
      message: entry.message,
      detail: entry.detail ?? {},
    });
    return !error;
  } catch {
    return false;
  }
}
