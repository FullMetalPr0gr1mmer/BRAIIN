import { TIMELINE_BAND_LABELS, type LeadInput } from '@schemas/lead';
import { resolveLaunchTenantId } from './tenant';
import { serviceClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/supabase/client';
import { encryptPII } from '@/lib/crypto/pii';
import { LEAD_PII_ENC_KEY } from 'astro:env/server';
import { canonicalServiceSlug } from '@/lib/services/retired';
import { normalizeEmail, normalizePhone } from '@/lib/crm/normalize';
import { blindIndex } from '@/lib/crm/blindIndex';
import { leadSignals } from '@/lib/crm/score';
import { writeSystemLog } from '@/lib/data/systemLog';

// Server-side lead creation (the "submit-contact-form" path). Resolves the tenant
// SERVER-SIDE (anon tenant fence — never client-chosen), envelope-encrypts PII, and
// writes with the service-role client. Public visitors never touch the leads table
// directly (RLS denies anon); this endpoint is the only public write path.
//
// Since 0035 (Admin v2 C1b) a lead arrives through `public.crm_ingest_lead`: the e-mail
// and phone are normalised and blind-indexed here, the score signals are worked out from
// the plaintext before it is encrypted, and the database adds `returning` and the score
// in the same transaction as the lead. The id is generated HERE, so a retry after a lost
// response is the same lead, never a second one.
//
// The contact form fails open (CLAUDE.md §3): if the RPC itself is unavailable (the
// function is missing, i.e. code ahead of its migration, or the network failed) the lead
// is written by the plain insert it always was, and the daily cron indexes it later. Any
// other RPC error is a real refusal (a CHECK, a bad field) and is NOT retried as an
// insert, which would only hide the bug.
export type CreateLeadResult =
  { ok: true } | { ok: false; reason: 'unconfigured' | 'no-tenant' | 'insert-failed' };

interface DbError {
  code?: string;
  message?: string;
}

/** The RPC is missing (PostgREST's schema cache or Postgres), or nothing answered at all. */
export function isRpcUnavailable(error: DbError): boolean {
  return error.code === 'PGRST202' || error.code === '42883' || !error.code;
}

export async function createLead(input: LeadInput): Promise<CreateLeadResult> {
  if (!supabaseConfigured()) return { ok: false, reason: 'unconfigured' };

  const sb = serviceClient();

  // Resolve the single launch tenant server-side (the anon fence — one definition,
  // shared with writeSystemLog(); see src/lib/data/tenant.ts).
  const tenantId = await resolveLaunchTenantId();
  if (!tenantId) return { ok: false, reason: 'no-tenant' };

  // A legacy band (pages cached before the v2 form) is stored as its words, encrypted,
  // like the free-text deadline; plaintext timeline_band is no longer written.
  const timeline =
    input.timelineText ??
    (input.timelineBand ? TIMELINE_BAND_LABELS[input.timelineBand] : undefined);

  const [email_enc, phone_enc, budget_enc, timeline_text_enc] = await Promise.all([
    encryptPII(input.email, LEAD_PII_ENC_KEY),
    input.phone ? encryptPII(input.phone, LEAD_PII_ENC_KEY) : Promise.resolve(null),
    input.budgetBand ? encryptPII(input.budgetBand, LEAD_PII_ENC_KEY) : Promise.resolve(null),
    // The deadline is a §3 `timeline` field — encrypted exactly like budget.
    timeline ? encryptPII(timeline, LEAD_PII_ENC_KEY) : Promise.resolve(null),
  ]);

  // Stored under the slug the service lives at now: the four Round 2 renames
  // (`videography` → `photo-video`) are converted, everything else is kept as given —
  // an archived slug stays what the visitor asked for and is labelled from its own row
  // (src/lib/leads/interestLabel.ts). Time-boxed exactly like LEGACY_BUDGET_BANDS
  // (packages/schemas/lead.ts): cached pages post the old slugs until they turn over.
  const serviceOfInterest = input.serviceOfInterest
    ? canonicalServiceSlug(input.serviceOfInterest)
    : null;

  const id = crypto.randomUUID();
  const lead: Record<string, unknown> = {
    id,
    kind: input.kind,
    locale: input.locale,
    name: input.name,
    company: input.company ?? null,
    email_enc,
    phone_enc,
    budget_enc,
    timeline_text_enc,
    message: input.message,
    service_of_interest: serviceOfInterest,
    discipline_of_interest: input.disciplineOfInterest ?? null,
    consent_marketing: input.consentMarketing,
    source: 'web_form',
    ...(await crmIndexes(sb, tenantId, input)),
  };

  const { error } = await sb.rpc('crm_ingest_lead', { p_tenant: tenantId, p_lead: lead });
  if (!error) return { ok: true };

  if (!isRpcUnavailable(error)) {
    // Codes and the field set only: never the lead.
    void writeSystemLog({
      level: 'error',
      source: 'contact:ingest',
      message: `crm_ingest_lead refused the lead (${error.code ?? 'no code'})`,
      detail: { code: error.code ?? null },
    });
    return { ok: false, reason: 'insert-failed' };
  }

  void writeSystemLog({
    level: 'warn',
    source: 'contact:ingest',
    message: 'crm_ingest_lead unavailable; the lead was written by the plain insert',
    detail: { code: error.code ?? null },
  });
  return fallbackInsert(sb, tenantId, id, lead);
}

/** Blind indexes and score signals for a new lead. Never throws: a lead outranks its index. */
async function crmIndexes(
  sb: ReturnType<typeof serviceClient>,
  tenantId: string,
  input: LeadInput,
): Promise<Record<string, unknown>> {
  try {
    const email = normalizeEmail(input.email);
    const phone = input.phone
      ? normalizePhone(input.phone, await tenantCountry(sb, tenantId))
      : null;
    const [email_hmac, phone_hmac] = await Promise.all([
      email ? blindIndex(LEAD_PII_ENC_KEY, 'email', tenantId, email) : Promise.resolve(null),
      phone ? blindIndex(LEAD_PII_ENC_KEY, 'phone', tenantId, phone) : Promise.resolve(null),
    ]);
    return { email_hmac, phone_hmac, score_signals: leadSignals({ ...input, email }) };
  } catch {
    // Unindexed is recoverable (the daily cron fills it in); a lost lead is not.
    return {};
  }
}

/** The tenant's country (site_profile), for reading local phone numbers. */
async function tenantCountry(
  sb: ReturnType<typeof serviceClient>,
  tenantId: string,
): Promise<string> {
  const { data } = await sb
    .from('site_profile')
    .select('address_country')
    .eq('tenant_id', tenantId)
    .maybeSingle<{ address_country: string }>();
  return data?.address_country ?? 'SA';
}

/**
 * The pre-0035 insert, with the same id. Columns only the RPC's migration added are left
 * out, so this works whether or not 0035 is applied; the cron indexes the lead later.
 * A duplicate id means the RPC did commit and only its answer was lost: success.
 */
async function fallbackInsert(
  sb: ReturnType<typeof serviceClient>,
  tenantId: string,
  id: string,
  lead: Record<string, unknown>,
): Promise<CreateLeadResult> {
  const {
    email_hmac: _e,
    phone_hmac: _p,
    score_signals: _s,
    source: _src,
    timeline_text_enc,
    discipline_of_interest,
    ...legacy
  } = lead;
  const { error } = await sb.from('leads').insert({
    ...legacy,
    tenant_id: tenantId,
    // Sent only when present: PostgREST rejects a column it has not seen, so these keep
    // working in the window before their migrations (0017, 0028), as they always did.
    ...(timeline_text_enc ? { timeline_text_enc } : {}),
    ...(discipline_of_interest ? { discipline_of_interest } : {}),
  });
  if (!error || error.code === '23505') return { ok: true };
  return { ok: false, reason: 'insert-failed' };
}
