import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AcceptedBudgetBandSchema,
  TIMELINE_BAND_LABELS,
  TimelineBandSchema,
  type BudgetBand,
} from '@schemas/lead';
import { decryptPII, encryptPII } from '@/lib/crypto/pii';
import { normalizeEmail, normalizePhone } from './normalize';
import { blindIndex } from './blindIndex';
import { leadSignals } from './score';

// The daily cron's lead indexing (Admin v2 C1b): leads that arrived before 0035, or
// through createLead's fallback insert, have no blind indexes, signals or score. This
// decrypts them on the server (no person sees the values), computes what arrival would
// have, and writes it through public.crm_index_lead, oldest first. It also moves a legacy
// plaintext timeline_band into the encrypted timeline.
//
// Each lead is its own commit, so a run that stops early (an error, or the Worker's CPU
// limit, owner item O-16) keeps what it did and the next day carries on. A lead whose
// ciphertext will not decrypt is indexed as empty rather than retried forever, so it can
// never block the leads behind it; a failed write is left for the next run.

/** Leads per run: small, because every one costs a few decryptions and HMACs of CPU. */
export const INDEX_BATCH = 100;

interface UnindexedLead {
  id: string;
  tenant_id: string;
  email_enc: string | null;
  phone_enc: string | null;
  budget_enc: string | null;
  timeline_text_enc: string | null;
  timeline_band: string | null;
  service_of_interest: string | null;
  company: string | null;
}

export interface IndexRun {
  scanned: number;
  indexed: number;
  failed: number;
}

export async function runLeadIndexBackfill(
  sb: SupabaseClient,
  rootKey: string,
  batch: number = INDEX_BATCH,
): Promise<IndexRun> {
  const { data, error } = await sb
    .from('leads')
    .select(
      'id,tenant_id,email_enc,phone_enc,budget_enc,timeline_text_enc,timeline_band,service_of_interest,company',
    )
    .is('crm_indexed_at', null)
    .order('created_at', { ascending: true })
    .limit(batch);
  if (error) throw new Error(`lead index backfill: ${error.message}`);

  const rows = (data ?? []) as UnindexedLead[];
  const countries = new Map<string, string>();
  const run: IndexRun = { scanned: rows.length, indexed: 0, failed: 0 };
  for (const row of rows) {
    const args = await indexArgs(sb, rootKey, row, countries);
    const { error: writeError } = await sb.rpc('crm_index_lead', args);
    if (writeError) run.failed += 1;
    else run.indexed += 1;
  }
  return run;
}

/** What arrival would have computed for this lead. Never throws. */
export async function indexArgs(
  sb: SupabaseClient,
  rootKey: string,
  row: UnindexedLead,
  countries: Map<string, string>,
): Promise<Record<string, unknown>> {
  const band = TimelineBandSchema.safeParse(row.timeline_band);
  let email: string | null = null;
  let phone: string | null = null;
  let budget: BudgetBand | undefined;
  try {
    const [plainEmail, plainPhone, plainBudget] = await Promise.all([
      row.email_enc ? decryptPII(row.email_enc, rootKey) : Promise.resolve(null),
      row.phone_enc ? decryptPII(row.phone_enc, rootKey) : Promise.resolve(null),
      row.budget_enc ? decryptPII(row.budget_enc, rootKey) : Promise.resolve(null),
    ]);
    email = plainEmail ? normalizeEmail(plainEmail) : null;
    phone = plainPhone
      ? normalizePhone(plainPhone, await countryFor(sb, row.tenant_id, countries))
      : null;
    const parsed = AcceptedBudgetBandSchema.safeParse(plainBudget);
    budget = parsed.success ? parsed.data : undefined;
  } catch {
    // Undecryptable: index what can be known without it.
  }

  const [email_hmac, phone_hmac, timelineTextEnc] = await Promise.all([
    email ? blindIndex(rootKey, 'email', row.tenant_id, email) : Promise.resolve(null),
    phone ? blindIndex(rootKey, 'phone', row.tenant_id, phone) : Promise.resolve(null),
    !row.timeline_text_enc && band.success
      ? encryptPII(TIMELINE_BAND_LABELS[band.data], rootKey)
      : Promise.resolve(null),
  ]);

  return {
    p_tenant: row.tenant_id,
    p_id: row.id,
    p_email_hmac: email_hmac,
    p_phone_hmac: phone_hmac,
    p_signals: leadSignals({
      email,
      serviceOfInterest: row.service_of_interest ?? undefined,
      budgetBand: budget,
      company: row.company ?? undefined,
      // Presence is all a signal needs; the deadline itself stays encrypted.
      timelineText: row.timeline_text_enc ? 'given' : undefined,
      timelineBand: band.success ? band.data : undefined,
    }),
    p_timeline_text_enc: timelineTextEnc,
  };
}

async function countryFor(
  sb: SupabaseClient,
  tenantId: string,
  cache: Map<string, string>,
): Promise<string> {
  const known = cache.get(tenantId);
  if (known) return known;
  const { data } = await sb
    .from('site_profile')
    .select('address_country')
    .eq('tenant_id', tenantId)
    .maybeSingle<{ address_country: string }>();
  const country = data?.address_country ?? 'SA';
  cache.set(tenantId, country);
  return country;
}
