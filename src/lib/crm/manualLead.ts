import type { SupabaseClient } from '@supabase/supabase-js';
import { LEAD_PII_ENC_KEY } from 'astro:env/server';
import type { LeadManualCreate } from '@schemas/crm';
import type { AuthContext } from '@/lib/auth/types';
import { ValidationError } from '@/lib/admin/errors';
import { ingestManualLead, type LeadIndexes } from '@/lib/data/leads';
import { blindIndex } from './blindIndex';
import { tenantCountry } from './leadQuery';
import { normalizeEmail, normalizePhone } from './normalize';
import { leadSignals } from './score';

// Adding a lead by hand (Admin v2 C3, crm.md §7.2). The caller holds leads.manage and
// leads.pii and has passed a live recheck (src/pages/api/admin/leads/index.ts).
//
// Duplicates are matched against earlier LEADS by blind index only (plan default B7-12;
// matching against contacts arrives with them, C5), so the address or number typed never
// reaches the database, only its HMAC:
//   • the same e-mail as an earlier lead is the same person: the lead is added, and the
//     answer names the earlier leads so the screen can say so;
//   • the same phone with no e-mail match may be someone else (a shared office number), so
//     the add stops with the matches (a 409) unless the caller says `createNew`.
// The lookups run as the caller (public.leads_list, SECURITY INVOKER): RLS and the live
// check decide what they can find, and they return safe columns only.

export interface EarlierLead {
  id: string;
  lead_number: number | null;
  name: string | null;
}

export type ManualLeadOutcome =
  | { kind: 'created'; id: string; sameEmail: EarlierLead[] }
  | { kind: 'possible-duplicate'; matches: EarlierLead[] };

/** How many earlier leads a match reports (enough to recognise someone, no more). */
const MATCH_LIMIT = 5;

/** Earlier leads of this tenant whose e-mail or phone has this blind index, as the caller. */
async function earlierLeads(
  sb: SupabaseClient,
  tenantId: string,
  kind: 'email' | 'phone',
  hmac: string,
): Promise<EarlierLead[]> {
  const { data, error } = await sb.rpc('leads_list', {
    p_tenant: tenantId,
    p_filter: { contact_kind: kind, contact_hmac: hmac, limit: MATCH_LIMIT },
  });
  if (error) throw new Error(`leads_list (duplicate check): ${error.code ?? 'no code'}`);
  const rows = (data as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) return [];
  return (rows as Record<string, unknown>[])
    .filter((row) => typeof row['id'] === 'string')
    .map((row) => ({
      id: row['id'] as string,
      lead_number: typeof row['lead_number'] === 'number' ? row['lead_number'] : null,
      name: typeof row['name'] === 'string' ? row['name'] : null,
    }));
}

export async function addManualLead(
  auth: AuthContext,
  sb: SupabaseClient,
  input: LeadManualCreate,
): Promise<ManualLeadOutcome> {
  const email = input.email ? normalizeEmail(input.email) : null;
  const phone = input.phone
    ? normalizePhone(input.phone, await tenantCountry(sb, auth.tenantId)())
    : null;
  // An e-mail or a phone that will not normalise is still stored (encrypted, as typed);
  // it only goes unindexed, exactly as on the public form.
  const [emailHmac, phoneHmac] = await Promise.all([
    email ? blindIndex(LEAD_PII_ENC_KEY, 'email', auth.tenantId, email) : Promise.resolve(null),
    phone ? blindIndex(LEAD_PII_ENC_KEY, 'phone', auth.tenantId, phone) : Promise.resolve(null),
  ]);

  const sameEmail = emailHmac ? await earlierLeads(sb, auth.tenantId, 'email', emailHmac) : [];
  if (sameEmail.length === 0 && phoneHmac && input.createNew !== true) {
    const samePhone = await earlierLeads(sb, auth.tenantId, 'phone', phoneHmac);
    if (samePhone.length > 0) return { kind: 'possible-duplicate', matches: samePhone };
  }

  const indexes: LeadIndexes = {
    email_hmac: emailHmac,
    phone_hmac: phoneHmac,
    // The same signals as the public form, from the plaintext before it is encrypted.
    score_signals: leadSignals({
      email,
      ...(input.serviceOfInterest !== undefined
        ? { serviceOfInterest: input.serviceOfInterest }
        : {}),
      ...(input.budgetBand !== undefined ? { budgetBand: input.budgetBand } : {}),
      ...(input.company !== undefined ? { company: input.company } : {}),
      ...(input.timeline !== undefined ? { timelineText: input.timeline } : {}),
    }),
  };
  const result = await ingestManualLead(auth.tenantId, auth.userId, input, indexes);
  if (!result.ok) {
    if (result.code === '22023' || result.code === '23514') {
      throw new ValidationError('The lead was refused. Check the details and try again.');
    }
    throw new Error(`crm_ingest_lead (manual): ${result.code ?? 'no code'}`);
  }
  return { kind: 'created', id: result.id, sameEmail };
}
