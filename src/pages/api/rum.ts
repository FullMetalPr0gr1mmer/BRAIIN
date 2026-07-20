import type { APIRoute } from 'astro';
import { hasConsent } from '@consent/gate';
import { WebVitalSchema } from '@schemas/webvitals';
import { isSameOrigin } from '@/lib/http/csrf';

// Consent-gated, first-party RUM web-vitals sink (CLAUDE.md §10). The client only
// beacons with analytics consent; the server RE-CHECKS here (defense in depth) and
// silently drops anything without consent — no row without analytics consent.
export const prerender = false;

// Tier C: `private, no-store` on EVERY branch. The consent-drop, 400 and 422 replies
// previously carried no cache header at all.
const NO_STORE = { 'cache-control': 'private, no-store' } as const;

export const POST: APIRoute = async ({ request }) => {
  // Explicit same-origin check: Astro's `security.checkOrigin` only rejects cross-origin
  // requests with a form-like content-type, so a cross-origin JSON POST is not covered.
  // navigator.sendBeacon from our own pages is same-origin and unaffected.
  if (!isSameOrigin(request.headers.get('origin'), request.headers.get('host'))) {
    return new Response('bad origin', { status: 403, headers: NO_STORE });
  }

  if (!hasConsent(request, 'analytics')) {
    return new Response(null, { status: 204, headers: NO_STORE }); // dropped, intentionally
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response('bad request', { status: 400, headers: NO_STORE });
  }

  const parsed = WebVitalSchema.safeParse(body);
  if (!parsed.success) {
    return new Response('invalid', { status: 422, headers: NO_STORE });
  }

  // TODO(phase-3): insert parsed.data into public.web_vitals via the service-role
  // client (tenant-scoped). Consent is already re-verified above.
  // TODO(KAN-20): WAF rate-limit per IP before that insert lands — an unauthenticated
  // path to a service-role write needs a row-count bound, not just a row-size bound.
  return new Response(null, { status: 204, headers: NO_STORE });
};
