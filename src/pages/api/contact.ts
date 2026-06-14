import type { APIRoute } from 'astro';
import { LeadInputSchema } from '@schemas/lead';
import { createLead } from '@/lib/data/leads';

// Public contact / project-inquiry submission — the ONLY public write path (RLS denies
// anon on the leads table). Server-side Zod validation + honeypot (schema) + same-origin
// CSRF check; the tenant is resolved server-side and PII is envelope-encrypted in
// createLead(). Edge rate-limit is added at the WAF (KAN-20).
export const prerender = false;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  // CSRF: same-origin only (defense-in-depth alongside Astro's security.checkOrigin).
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) return json({ ok: false, error: 'bad-origin' }, 403);
    } catch {
      return json({ ok: false, error: 'bad-origin' }, 403);
    }
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'bad-request' }, 400);
  }

  // A filled honeypot (`hp`) fails schema validation (max length 0) → treated as spam.
  const parsed = LeadInputSchema.safeParse(body);
  if (!parsed.success) return json({ ok: false, error: 'validation' }, 422);

  // TODO(KAN-20): verify parsed.data.captchaToken with reCAPTCHA once provisioned.
  const result = await createLead(parsed.data);
  if (result.ok) return json({ ok: true }, 200);
  if (result.reason === 'unconfigured') return json({ ok: false, error: 'unavailable' }, 503);
  return json({ ok: false, error: 'server' }, 500);
};
