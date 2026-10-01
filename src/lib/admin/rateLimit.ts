import type { AuthContext } from '@/lib/auth/types';
import { serviceClient } from '@/lib/supabase/server';
import { RateLimitError } from './errors';

// Rate limiting for privileged, RLS-bypassing operations — `export-csv` and
// `export-backup` (CLAUDE.md §3: "3/hr/user AND tenant aggregate").
//
// Two ceilings, not one, because they stop different things:
//   • per-user catches one compromised or curious account pulling the lead table
//     repeatedly
//   • per-tenant catches the case the per-user limit cannot see — several accounts
//     each staying under their own limit, which is what an attacker with more than one
//     credential does
//
// Backed by `privileged_ops` (service_role only, no RLS policies) rather than by an
// in-memory counter: the Worker is horizontally scaled and evicted constantly, so a
// per-isolate counter would reset itself into uselessness under exactly the load it is
// supposed to bound.
//
// FAILS CLOSED. If the ledger cannot be read, the export is refused. An export that
// proceeds without a countable record is precisely the event this table exists to make
// impossible.

export interface RateLimitOptions {
  perUser: number;
  perTenant: number;
  windowMinutes: number;
}

export const EXPORT_LIMITS: RateLimitOptions = {
  perUser: 3,
  perTenant: 10,
  windowMinutes: 60,
};

/**
 * Claims one slot for a privileged operation, or refuses with RateLimitError. Call it
 * BEFORE the work, so an operation that dies halfway still consumed its slot.
 *
 * The record is written FIRST and the window counted after, including it. Counting first
 * and recording after let parallel requests all pass a count none of them had joined yet
 * (N simultaneous downloads through a limit of 3). Written first, at most `limit` claims
 * can ever see a count within the limit: each count includes its own row and every row
 * committed before it. A refused claim deletes its own row again, so retrying while over
 * the limit does not keep the window full.
 *
 * FAILS CLOSED: a ledger that cannot be written or read refuses the operation.
 */
export async function claimPrivilegedOp(
  auth: AuthContext,
  op: string,
  limits: RateLimitOptions = EXPORT_LIMITS,
): Promise<void> {
  const since = new Date(Date.now() - limits.windowMinutes * 60_000).toISOString();
  const sb = serviceClient();
  let ownId: unknown = null;

  try {
    const { data, error } = await sb
      .from('privileged_ops')
      .insert({ tenant_id: auth.tenantId, actor_id: auth.userId, op })
      .select('id')
      .single();
    if (error || !data) throw new Error('rate-limit ledger unavailable');
    ownId = (data as { id?: unknown }).id ?? null;

    const [userResult, tenantResult] = await Promise.all([
      sb
        .from('privileged_ops')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', auth.tenantId)
        .eq('actor_id', auth.userId)
        .eq('op', op)
        .gte('created_at', since),
      sb
        .from('privileged_ops')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', auth.tenantId)
        .eq('op', op)
        .gte('created_at', since),
    ]);

    if (userResult.error || tenantResult.error) throw new Error('rate-limit ledger unavailable');
    if ((userResult.count ?? Infinity) > limits.perUser) throw new RateLimitError(`${op}:user`);
    if ((tenantResult.count ?? Infinity) > limits.perTenant)
      throw new RateLimitError(`${op}:tenant`);
  } catch (err) {
    if (ownId !== null) {
      try {
        await sb.from('privileged_ops').delete().eq('id', ownId);
      } catch {
        // Best effort: a row left behind only makes the limit stricter.
      }
    }
    if (err instanceof RateLimitError) throw err;
    throw new RateLimitError(`${op}:unavailable`);
  }
}
