import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { writeSystemLog } from '@/lib/data/systemLog';

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
 *
 * ...but "surfaced to the caller" was only half of it, and the other half cost us. The
 * chain trigger called pgcrypto's `hmac` unqualified against a search_path without
 * `extensions`, so EVERY insert raised — and this function dutifully returned `false` to
 * callers that do not check it. The CMS worked perfectly and recorded nothing, for twelve
 * migrations, with no error in any log. "Must not throw" and "must not be noticed" are
 * different requirements and only the first was implemented.
 *
 * So a failure now also lands in `system_logs`, which is a different table with a
 * different write path (service-role, no chain trigger) — deliberately, because the most
 * likely reason an audit write fails is that something about audit_log itself is broken.
 * `writeSystemLog` never throws and is fire-and-forget, so this cannot turn a lost audit
 * row into a failed request.
 */
export async function writeAudit(
  sb: SupabaseClient,
  ctx: AuthContext,
  entry: AuditEntry,
): Promise<boolean> {
  const report = async (reason: string, detail: Record<string, unknown>): Promise<false> => {
    // detail carries the ACTION and the failure, never the audited values — audit rows
    // are metadata by construction (§3), and this sink is one hop further from review.
    await writeSystemLog({
      level: 'error',
      source: 'audit',
      message: `audit_log write failed (${reason}) for action "${entry.action}"`,
      detail: { action: entry.action, entityType: entry.entityType ?? null, ...detail },
    });
    return false;
  };

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
    if (error) return await report('insert rejected', { code: error.code, message: error.message });
    return true;
  } catch (err) {
    return await report('threw', { message: err instanceof Error ? err.message : String(err) });
  }
}
