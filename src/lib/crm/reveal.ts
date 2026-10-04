import type { SupabaseClient } from '@supabase/supabase-js';
import { LEAD_PII_ENC_KEY } from 'astro:env/server';
import type { AuthContext } from '@/lib/auth/types';
import { writeAudit } from '@/lib/admin/audit';
import { NotFoundError } from '@/lib/admin/errors';
import { AuthorizationError } from '@/lib/authz/errors';
import { getRow } from '@/lib/admin/crud';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { claimPrivilegedOp, PII_REVEAL_LIMITS } from '@/lib/admin/rateLimit';
import { decryptPII } from '@/lib/crypto/pii';
import { GATED_LEAD_COLUMNS, SAFE_LEAD_COLUMNS } from '@/lib/admin/leadFields';
import { serviceClient } from '@/lib/supabase/server';

// Revealing one lead's contact details: the single path both the legacy panel
// (GET /api/admin/leads/[id]?pii=1) and the CRM (POST /api/admin/leads/[id]/reveal) take.
// The caller has already passed assertCap('leads.pii'). In order, each step before the
// next, and any failure stops everything after it:
//
//   1. live recheck          the profile, now (demotion effective immediately)
//   2. rate limit            60 an hour per person, 300 per tenant (O-9), fail-closed:
//                            one lead at a time, never the table reveal by reveal
//   3. RLS read              the caller's own client must see this lead (live check
//                            included); an unseen lead is a 404 here
//   4. audit row, WRITTEN    fail-closed: no row, no reveal (PDPL accountability)
//   5. gated columns         as the service role, this lead and tenant only: staff tokens
//                            cannot read them at all (0033)
//   6. decrypt               in the Worker; a value that will not decrypt is null

/** Decrypted response field → the ciphertext column it comes from. */
export const DECRYPTED_FIELDS = {
  email: 'email_enc',
  phone: 'phone_enc',
  budget: 'budget_enc',
  // The v2 form's free-text "When do you need it?" (0017) — a §3 timeline field.
  timeline: 'timeline_text_enc',
} as const;

export interface Reveal {
  /** The safe columns, as the caller's own client read them. */
  row: Record<string, unknown>;
  /** Gated but not encrypted (timeline_band, internal_notes, ip_inet): as stored. */
  plain: Record<string, unknown>;
  /** email, phone, budget, timeline: decrypted, or null. */
  decrypted: Record<keyof typeof DECRYPTED_FIELDS, string | null>;
}

export async function revealLead(
  auth: AuthContext,
  sb: SupabaseClient,
  id: string,
): Promise<Reveal> {
  await liveRecheck(auth);
  await claimPrivilegedOp(auth, 'pii-reveal', PII_REVEAL_LIMITS);

  const row = await getRow<Record<string, unknown>>(sb, 'leads', auth, id, SAFE_LEAD_COLUMNS);

  // Field NAMES only: an audit entry that quoted the values would move the PII into a
  // table that is append-only by design, out of the retention purge's reach.
  const logged = await writeAudit(sb, auth, {
    action: 'lead.view_pii',
    entityType: 'lead',
    entityId: id,
    detail: { pii: true, fields: Object.keys(DECRYPTED_FIELDS) },
  });
  if (!logged) throw new AuthorizationError('leads.pii', 'audit unavailable — refused');

  const { data, error } = await serviceClient()
    .from('leads')
    .select(GATED_LEAD_COLUMNS)
    .eq('tenant_id', auth.tenantId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`read lead pii: ${error.message}`);
  // Deleted between the RLS read and now (retention, erasure): the same answer as unseen.
  if (!data) throw new NotFoundError('lead');
  const gated = data as Record<string, unknown>;

  const decrypted = {} as Record<keyof typeof DECRYPTED_FIELDS, string | null>;
  for (const [field, column] of Object.entries(DECRYPTED_FIELDS) as [
    keyof typeof DECRYPTED_FIELDS,
    string,
  ][]) {
    const ciphertext = gated[column];
    if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
      decrypted[field] = null;
      continue;
    }
    try {
      decrypted[field] = await decryptPII(ciphertext, LEAD_PII_ENC_KEY);
    } catch {
      // A record that will not decrypt is a data-integrity problem, not an authz one.
      decrypted[field] = null;
    }
  }

  const { email_enc: _e, phone_enc: _p, budget_enc: _b, timeline_text_enc: _t, ...plain } = gated;
  return { row, plain, decrypted };
}
