import type { APIRoute } from 'astro';
import { LeadInputSchema } from '@schemas/lead';
import { createLead } from '@/lib/data/leads';
import { isSameOrigin } from '@/lib/http/csrf';
import { clientIp } from '@/lib/http/maintenance';
import { CONTACT_LIMITS, checkPublicLimits } from '@/lib/http/publicRateLimit';
import { serviceClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/supabase/client';
import { resolveLaunchTenantId } from '@/lib/data/tenant';
import { LEAD_PII_ENC_KEY } from 'astro:env/server';

// Public contact / project-inquiry submission — the ONLY public write path (RLS denies
// anon on the leads table). Server-side Zod validation + honeypot (schema) + same-origin
// CSRF check; the tenant is resolved server-side and PII is envelope-encrypted in
// createLead(). A per-address limit (10 an hour, the public write limiter — EXC-004) runs
// before the insert and FAILS OPEN: an unreachable limiter must not cost a real lead. The
// edge rate limit is added at the WAF with the zone (KAN-20).
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

  if (supabaseConfigured()) {
    const tenantId = await resolveLaunchTenantId();
    if (tenantId) {
      const outcome = await checkPublicLimits(serviceClient(), tenantId, LEAD_PII_ENC_KEY, [
        { scope: 'contact:ip', value: clientIp(request) ?? 'unknown', ...CONTACT_LIMITS.perIp },
      ]);
      if (outcome === 'limited') return json({ ok: false, error: 'rate-limit' }, 429);
    }
  }

  // TODO(KAN-20): verify parsed.data.captchaToken with reCAPTCHA once provisioned.
  const result = await createLead(parsed.data);
  if (result.ok) return json({ ok: true }, 200);
  if (result.reason === 'unconfigured') return json({ ok: false, error: 'unavailable' }, 503);
  return json({ ok: false, error: 'server' }, 500);
};
