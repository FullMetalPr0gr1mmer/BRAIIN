import type { LeadInput } from '@schemas/lead';
import { resolveLaunchTenantId } from './tenant';
import { serviceClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/supabase/client';
import { encryptPII } from '@/lib/crypto/pii';
import { LEAD_PII_ENC_KEY } from 'astro:env/server';
import { canonicalServiceSlug } from '@/lib/services/retired';

// Server-side lead creation (the "submit-contact-form" path). Resolves the tenant
// SERVER-SIDE (anon tenant fence — never client-chosen), envelope-encrypts PII, and
// inserts via the service-role client. Public visitors never touch the leads table
// directly (RLS denies anon); this endpoint is the only public write path.
export type CreateLeadResult =
  { ok: true } | { ok: false; reason: 'unconfigured' | 'no-tenant' | 'insert-failed' };

export async function createLead(input: LeadInput): Promise<CreateLeadResult> {
  if (!supabaseConfigured()) return { ok: false, reason: 'unconfigured' };

  const sb = serviceClient();

  // Resolve the single launch tenant server-side (the anon fence — one definition,
  // shared with writeSystemLog(); see src/lib/data/tenant.ts).
  const tenantId = await resolveLaunchTenantId();
  if (!tenantId) return { ok: false, reason: 'no-tenant' };

  const [email_enc, phone_enc, budget_enc, timeline_text_enc] = await Promise.all([
    encryptPII(input.email, LEAD_PII_ENC_KEY),
    input.phone ? encryptPII(input.phone, LEAD_PII_ENC_KEY) : Promise.resolve(null),
    input.budgetBand ? encryptPII(input.budgetBand, LEAD_PII_ENC_KEY) : Promise.resolve(null),
    // The free-text deadline is a §3 `timeline` field — encrypted exactly like budget.
    input.timelineText ? encryptPII(input.timelineText, LEAD_PII_ENC_KEY) : Promise.resolve(null),
  ]);

  const { error } = await sb.from('leads').insert({
    tenant_id: tenantId,
    kind: input.kind,
    locale: input.locale,
    name: input.name,
    company: input.company ?? null,
    email_enc,
    phone_enc,
    budget_enc,
    timeline_band: input.timelineBand ?? null,
    // Sent only when present. PostgREST rejects an insert naming a column it has not
    // seen, so an always-present key would turn every contact submission into a 500 in
    // the window between this code deploying and migration 0017 being applied. Unset
    // keeps the old shape; set requires 0017 (which the deploy guard enforces).
    ...(timeline_text_enc ? { timeline_text_enc } : {}),
    message: input.message,
    // Stored under the slug the service lives at now: the four Round 2 renames
    // (`videography` → `photo-video`) are converted, everything else is kept as given —
    // an archived slug stays what the visitor asked for and is labelled from its own row
    // (src/lib/leads/interestLabel.ts). Time-boxed exactly like LEGACY_BUDGET_BANDS
    // (packages/schemas/lead.ts): cached pages post the old slugs until they turn over.
    service_of_interest: input.serviceOfInterest
      ? canonicalServiceSlug(input.serviceOfInterest)
      : null,
    // "{Discipline}, help me choose" (0028). Sent only when present, like
    // timeline_text_enc above: an always-present key would fail every submission in the
    // window between this code deploying and 0028 being applied.
    ...(input.disciplineOfInterest ? { discipline_of_interest: input.disciplineOfInterest } : {}),
    consent_marketing: input.consentMarketing,
  });

  return error ? { ok: false, reason: 'insert-failed' } : { ok: true };
}
