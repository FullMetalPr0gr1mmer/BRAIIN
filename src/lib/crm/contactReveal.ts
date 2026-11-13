import type { SupabaseClient } from '@supabase/supabase-js';
import { LEAD_PII_ENC_KEY } from 'astro:env/server';
import type { AuthContext } from '@/lib/auth/types';
import { writeAudit } from '@/lib/admin/audit';
import { AuthorizationError } from '@/lib/authz/errors';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { claimPrivilegedOp, PII_REVEAL_LIMITS } from '@/lib/admin/rateLimit';
import { decryptPII } from '@/lib/crypto/pii';
import { serviceClient } from '@/lib/supabase/server';
import { contactError, getContact, seesEveryContactChannel } from './contacts';

// Revealing one contact's e-mails and phones (Admin v2 C6, crm.md §9): the single path that
// decrypts a contact channel, POST /api/admin/crm/contacts/[id]/reveal. The caller has
// already passed assertCap('crm.contacts'). The lead reveal's order (src/lib/crm/reveal.ts),
// each step before the next, any failure stopping everything after it:
//
//   1. live recheck          the profile, now (demotion effective immediately)
//   2. rate limit            the SAME ledger key as the lead reveal (`pii-reveal`: 60 an hour
//                            per person, 300 per tenant, fail-closed), so a contact reveal
//                            and a lead reveal draw on one allowance: one person at a time,
//                            never the directory reveal by reveal
//   3. RLS read              the caller's own client must see this contact (live check
//                            included); an unseen contact or a tombstone is a 404 here
//   4. audit row, WRITTEN    fail-closed: no row, no reveal (PDPL accountability); field
//                            names and counts only, never a value
//   5. ciphertext            as the service role, through the reveal's door
//                            (public.crm_contact_reveal_channels, 0141), this contact and
//                            tenant only: staff tokens cannot read value_enc at all (C5's
//                            column grant), and the door checks the actor live and decides
//                            which channels it answers (below)
//   6. decrypt               in the Worker; a value that will not decrypt is null
//
// Which channels (the owner's decision of 2026-11-13): a role that sees every channel
// (`seesEveryContactChannel`: the holder of crm.erase, Admin, who also removes one and chooses
// the main one) gets every e-mail and phone; anyone else (Sales) the main e-mail and the main
// phone only. Decided twice: by the door from the actor's live profile (app.crm_eraser_ok),
// and here again from the role (a belt: a non-primary row never leaves for such a role).

/** The ledger key the lead reveal claims (src/lib/crm/reveal.ts): one allowance for both. */
export const CONTACT_REVEAL_OP = 'pii-reveal';

export interface RevealedChannel {
  id: string;
  kind: 'email' | 'phone';
  isPrimary: boolean;
  source: string;
  /** The decrypted value, or null when it will not decrypt. */
  value: string | null;
}

export async function revealContact(
  auth: AuthContext,
  sb: SupabaseClient,
  id: string,
): Promise<RevealedChannel[]> {
  await liveRecheck(auth);
  await claimPrivilegedOp(auth, CONTACT_REVEAL_OP, PII_REVEAL_LIMITS);
  await getContact(sb, auth, id, 'id');

  const every = seesEveryContactChannel(auth.role);
  const logged = await writeAudit(sb, auth, {
    action: 'crm.contact.view_pii',
    entityType: 'contact',
    entityId: id,
    // `scope`: every channel (Admin) or the main e-mail and phone only (Sales).
    detail: { pii: true, fields: ['emails', 'phones'], scope: every ? 'all' : 'main' },
  });
  if (!logged) throw new AuthorizationError('crm.contacts', 'audit unavailable, refused');

  const { data, error } = await serviceClient().rpc('crm_contact_reveal_channels', {
    p_tenant: auth.tenantId,
    p_contact: id,
    p_actor: auth.userId,
  });
  if (error) throw contactError(error, 'the contact details');

  const out: RevealedChannel[] = [];
  for (const row of (Array.isArray(data) ? data : []) as Record<string, unknown>[]) {
    const kind = row['kind'];
    if (kind !== 'email' && kind !== 'phone') continue;
    if (!every && row['is_primary'] !== true) continue;
    const ciphertext = row['value_enc'];
    let value: string | null = null;
    if (typeof ciphertext === 'string' && ciphertext.length > 0) {
      try {
        value = await decryptPII(ciphertext, LEAD_PII_ENC_KEY);
      } catch {
        // A value that will not decrypt is a data-integrity problem, not an authz one.
        value = null;
      }
    }
    out.push({
      id: String(row['id']),
      kind,
      isPrimary: row['is_primary'] === true,
      source: String(row['source']),
      value,
    });
  }
  return out;
}
