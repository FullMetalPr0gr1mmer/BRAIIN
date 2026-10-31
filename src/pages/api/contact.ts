import type { APIRoute } from 'astro';
import { LeadInputSchema } from '@schemas/lead';
import { createLead } from '@/lib/data/leads';
import { isSameOrigin } from '@/lib/http/csrf';
import { clientIp } from '@/lib/http/maintenance';
import { CONTACT_LIMITS, checkPublicLimits, ipLimitValue } from '@/lib/http/publicRateLimit';
import { serviceClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/supabase/client';
import { resolveLaunchTenantId } from '@/lib/data/tenant';
import { LEAD_PII_ENC_KEY } from 'astro:env/server';
import { checkInquiry } from '@/lib/forms/config';
import type { InquiryConfig } from '@schemas/forms';
import { readPublishedFormSettings } from '@/lib/forms/published';

// Public contact / project-inquiry submission — the ONLY public write path (RLS denies
// anon on the leads table). Server-side Zod validation + honeypot (schema) + same-origin
// CSRF check; the tenant is resolved server-side and PII is envelope-encrypted in
// createLead(). A per-address limit (10 an hour, the public write limiter — EXC-004) runs
// before the insert and FAILS OPEN: an unreachable limiter must not cost a real lead. The
// edge rate limit is added at the WAF with the zone (KAN-20).
//
// The published forms config (Admin v2 E8) narrows the schema, never loosens it: a field the
// sending form does not ask (or the config hides) is dropped, one the config requires is a 422
// when empty (src/lib/forms/config.ts checkInquiry). It is read with the service client for
// the tenant resolved here; an unreadable config leaves the schema floor (fail open, as the
// limiter) but still drops what the sending form does not ask (minimisation never fails open).
export const prerender = false;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  // CSRF: same-origin only (defense-in-depth alongside Astro's security.checkOrigin).
  if (!isSameOrigin(request.headers.get('origin'), request.headers.get('host'))) {
    return json({ ok: false, error: 'bad-origin' }, 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'bad-request' }, 400);
  }

  // A filled honeypot (`hp`) fails schema validation (max length 0) → treated as spam.
  // A 422 names the schema KEYS that failed (never their values) so the form can mark the
  // right fields; the honeypot is never named — a bot learns nothing about the trap.
  const parsed = LeadInputSchema.safeParse(body);
  if (!parsed.success) {
    const fields = [
      ...new Set(
        parsed.error.issues
          .map((i) => i.path[0])
          .filter((k): k is string => typeof k === 'string' && k !== 'hp'),
      ),
    ];
    return json({ ok: false, error: 'validation', fields }, 422);
  }

  // The built-in forms until the published config is read: an unreadable config fails open on
  // availability only, never on minimisation (a field the sending form does not ask is still
  // dropped; with no config nothing optional is required).
  let inquiry: InquiryConfig = {};
  if (supabaseConfigured()) {
    const tenantId = await resolveLaunchTenantId();
    if (tenantId) {
      // The limiter and the config are independent reads, so they run together (review
      // finding CR9): one round trip, not two. The order of the answers is unchanged: a
      // limited send is a 429 whatever the config says, and neither read can fail the send
      // (the limiter fails open, an unreadable config leaves the floor).
      const svc = serviceClient();
      const [outcome, settings] = await Promise.all([
        checkPublicLimits(svc, tenantId, LEAD_PII_ENC_KEY, [
          { scope: 'contact:ip', value: ipLimitValue(clientIp(request)), ...CONTACT_LIMITS.perIp },
        ]),
        readPublishedFormSettings(svc, tenantId),
      ]);
      if (outcome === 'limited') return json({ ok: false, error: 'rate-limit' }, 429);
      if (settings) inquiry = settings.inquiry;
    }
  }
  // The page's claim (the optional fields it showed as required) narrows what the config
  // requires, so a page drawn before a field became required still sends (CR1).
  const checked = checkInquiry(parsed.data, inquiry, parsed.data.form, parsed.data.requiredFields);
  if (!checked.ok) return json({ ok: false, error: 'validation', fields: checked.fields }, 422);
  const lead = checked.data;

  // TODO(KAN-20): verify the captcha token with reCAPTCHA once provisioned (O-19).
  const result = await createLead(lead);
  if (result.ok) return json({ ok: true }, 200);
  if (result.reason === 'unconfigured') return json({ ok: false, error: 'unavailable' }, 503);
  return json({ ok: false, error: 'server' }, 500);
};
