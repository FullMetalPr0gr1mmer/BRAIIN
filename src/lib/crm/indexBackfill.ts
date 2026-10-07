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

// The daily cron's lead indexing (Admin v2 C1b): leads that arrived before 0035, without
// their indexes, or through createLead's fallback insert have no blind indexes, signals or
// score. This decrypts their e-mail, phone and budget in memory (no person sees the values,
// and nothing but HMACs and signal names leaves this module), computes what arrival would
// have, and writes it through public.crm_index_lead, oldest first. It also moves a legacy
// plaintext timeline_band into the encrypted timeline.
//
// Each lead is its own commit, so a run that stops early (an error, or the Worker's CPU
// limit, owner item O-16) keeps what it did and the next day carries on. Each field is
// decrypted on its own: a corrupt field costs only its own index, and a lead with one is
// indexed with what could be read rather than retried forever, so it never blocks the
// leads behind it. But when NOTHING in the batch decrypts, the key is wrong, not the data:
// the run writes nothing at all (no index, no band re-encrypted under that key, no
// plaintext dropped) and reports it once, in its log line. A failed write is left for the
// next run.

/**
 * Leads per run, sized for the Workers Free plan (O-16): 50 subrequests and 10 ms of CPU per
 * invocation, shared with the other daily jobs (src/lib/cron/daily.ts has the sum). This
 * step spends one read, one country lookup per tenant and one write per lead, and each lead
 * costs a few decryptions and HMACs of CPU.
 */
export const INDEX_BATCH = 20;

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
  /** Leads indexed with a field that would not decrypt. */
  unreadable: number;
  /** Set when the run wrote nothing because the key decrypts none of the batch. */
  stopped?: 'key';
}

export function newIndexRun(): IndexRun {
  return { scanned: 0, indexed: 0, failed: 0, unreadable: 0 };
}

/**
 * Indexes one batch. `run` is filled in as the batch goes, so a caller that catches an
 * error part-way still has the counts of what was done.
 */
export async function runLeadIndexBackfill(
  sb: SupabaseClient,
  rootKey: string,
  batch: number = INDEX_BATCH,
  run: IndexRun = newIndexRun(),
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
  run.scanned = rows.length;

  // Every decryption first, before anything is written: a key that reads none of the batch
  // must not get as far as a write.
  const plains = await Promise.all(rows.map((row) => decryptFields(row, rootKey)));
  if (plains.some((p) => p.tried > 0) && !plains.some((p) => p.read > 0)) {
    run.stopped = 'key';
    return run;
  }

  const countries = new Map<string, string>();
  for (const [i, row] of rows.entries()) {
    const plain = plains[i]!;
    if (plain.read < plain.tried) run.unreadable += 1;
    const args = await indexArgs(sb, rootKey, row, plain, countries);
    const { error: writeError } = await sb.rpc('crm_index_lead', args);
    if (writeError) run.failed += 1;
    else run.indexed += 1;
  }
  return run;
}

interface PlainFields {
  email: string | null;
  phone: string | null;
  budget: string | null;
  /** Ciphertexts present, and how many of them decrypted. */
  tried: number;
  read: number;
}

/** The lead's e-mail, phone and budget, each decrypted on its own. Never throws. */
async function decryptFields(row: UnindexedLead, rootKey: string): Promise<PlainFields> {
  const ciphertexts = [row.email_enc, row.phone_enc, row.budget_enc];
  const results = await Promise.allSettled(
    ciphertexts.map((c) => (c ? decryptPII(c, rootKey) : Promise.resolve(null))),
  );
  const value = (i: number): string | null => {
    const result = results[i];
    return result?.status === 'fulfilled' ? result.value : null;
  };
  return {
    email: value(0),
    phone: value(1),
    budget: value(2),
    tried: ciphertexts.filter(Boolean).length,
    read: results.filter((r, i) => ciphertexts[i] && r.status === 'fulfilled').length,
  };
}

/** What arrival would have computed for this lead, from what could be read. Never throws. */
async function indexArgs(
  sb: SupabaseClient,
  rootKey: string,
  row: UnindexedLead,
  plain: PlainFields,
  countries: Map<string, string>,
): Promise<Record<string, unknown>> {
  const band = TimelineBandSchema.safeParse(row.timeline_band);
  const email = plain.email ? normalizeEmail(plain.email) : null;
  const phone = plain.phone
    ? normalizePhone(plain.phone, await countryFor(sb, row.tenant_id, countries))
    : null;
  const parsed = AcceptedBudgetBandSchema.safeParse(plain.budget);
  const budget: BudgetBand | undefined = parsed.success ? parsed.data : undefined;

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
