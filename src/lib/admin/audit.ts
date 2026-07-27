import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';

// Append-only audit trail (CLAUDE.md §3 / §10).
//
// This module writes the ROW. It does NOT compute the hash: the `audit_log_chain`
// BEFORE INSERT trigger does that in the database, keyed from Supabase Vault, on every
// insert path including service_role. That split is the whole point — a caller that
// could supply `hash` could also supply a plausible-looking wrong one, and the chain
// would verify against itself forever. So there is no `hash` field here to pass.
//
// `detail` is metadata about the change (which fields, which status, how many rows) —
// never the changed VALUES for PII-bearing entities. The lead endpoints log
// `{ fields: ['email','phone'] }`, not the email.

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string;
  detail?: Record<string, unknown>;
}

/**
 * Writes one audit row as the acting user (RLS `audit_insert` allows staff).
 *
 * Returns false instead of throwing: an audit write must not roll back the operation
 * it describes. Silent loss would be worse, so a failure is surfaced to the caller,
 * and the privileged endpoints (§3: exports) treat a failed PRE-write as fatal and
 * refuse to dump — "we could not record that this happened" is a reason not to do it.
 */
export async function writeAudit(
  sb: SupabaseClient,
  ctx: AuthContext,
  entry: AuditEntry,
): Promise<boolean> {
  try {
    const { error } = await sb.from('audit_log').insert({
      tenant_id: ctx.tenantId,
      actor_id: ctx.userId,
      actor_role: ctx.role,
      action: entry.action,
      entity_type: entry.entityType ?? null,
      entity_id: entry.entityId ?? null,
      detail: entry.detail ?? {},
    });
    return !error;
  } catch {
    return false;
  }
}
