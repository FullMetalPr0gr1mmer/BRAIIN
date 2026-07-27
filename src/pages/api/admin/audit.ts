import { z } from 'zod';
import { defineAdminRoute } from '@/lib/admin/route';
import { listRows } from '@/lib/admin/crud';

// Audit-log reader — `audit.view` (Admin + Developer). Read-only by construction: the
// table has no UPDATE or DELETE policy and those grants are revoked even from
// service_role (migration 0002), so there is deliberately no write method here to
// mirror.
//
// `verifyChain` re-walks the HMAC chain links this page returned. It cannot recompute
// the hashes — the key lives in Supabase Vault, readable only by the trigger's definer,
// which is exactly why an admin with database access still cannot forge an entry. What
// it CAN do is check that each row's `prev_hash` matches its predecessor's `hash`, which
// catches deletion or reordering. Detecting a rewritten hash is the hourly R2-anchor
// verifier's job (§10), not this endpoint's.

export const prerender = false;

const AuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  action: z.string().max(80).optional(),
  entityType: z.string().max(60).optional(),
});

export const GET = defineAdminRoute({
  cap: 'audit.view',
  input: AuditQuerySchema,
  handler: async ({ auth, sb, input }) => {
    const filters: Record<string, string> = {};
    if (input.action) filters['action'] = input.action;
    if (input.entityType) filters['entity_type'] = input.entityType;

    const { rows, total } = await listRows<Record<string, unknown>>(sb, 'audit_log', auth, {
      columns:
        'id,actor_id,actor_role,action,entity_type,entity_id,detail,prev_hash,hash,created_at',
      orderBy: { column: 'id', ascending: false },
      filters,
      limit: input.limit,
      offset: input.offset,
    });

    return {
      rows,
      total,
      limit: input.limit,
      offset: input.offset,
      chain: verifyChain(rows),
    };
  },
});

interface ChainReport {
  contiguous: boolean;
  brokenAt: number | null;
}

/** Rows arrive newest-first, so each row should be the `prev_hash` of the one above it. */
function verifyChain(rows: readonly Record<string, unknown>[]): ChainReport {
  for (let i = 0; i < rows.length - 1; i += 1) {
    const newer = rows[i];
    const older = rows[i + 1];
    if (!newer || !older) continue;
    if (newer['prev_hash'] !== older['hash']) {
      return { contiguous: false, brokenAt: Number(newer['id']) };
    }
  }
  return { contiguous: true, brokenAt: null };
}
