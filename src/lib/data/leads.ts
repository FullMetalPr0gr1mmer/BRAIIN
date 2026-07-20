import type { LeadInput } from '@schemas/lead';
import { resolveLaunchTenantId } from './tenant';
import { serviceClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/supabase/client';
import { encryptPII } from '@/lib/crypto/pii';
import { LEAD_PII_ENC_KEY } from 'astro:env/server';

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

  const [email_enc, phone_enc, budget_enc] = await Promise.all([
    encryptPII(input.email, LEAD_PII_ENC_KEY),
    input.phone ? encryptPII(input.phone, LEAD_PII_ENC_KEY) : Promise.resolve(null),
    input.budgetBand ? encryptPII(input.budgetBand, LEAD_PII_ENC_KEY) : Promise.resolve(null),
  ]);

  const { error } = await sb.from('leads').insert({
    tenant_id: tenantId,
    kind: input.kind,
    locale: input.locale,
    name: input.name,
    email_enc,
    phone_enc,
    budget_enc,
    timeline_band: input.timelineBand ?? null,
    message: input.message,
    service_of_interest: input.serviceOfInterest ?? null,
    consent_marketing: input.consentMarketing,
  });

  return error ? { ok: false, reason: 'insert-failed' } : { ok: true };
}
