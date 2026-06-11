import type { APIRoute } from 'astro';
import { hasConsent } from '@consent/gate';
import { WebVitalSchema } from '@schemas/webvitals';

// Consent-gated, first-party RUM web-vitals sink (CLAUDE.md §10). The client only
// beacons with analytics consent; the server RE-CHECKS here (defense in depth) and
// silently drops anything without consent — no row without analytics consent.
export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!hasConsent(request, 'analytics')) {
    return new Response(null, { status: 204 }); // dropped, intentionally
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }

  const parsed = WebVitalSchema.safeParse(body);
  if (!parsed.success) {
    return new Response('invalid', { status: 422 });
  }

  // TODO(phase-3): insert parsed.data into public.web_vitals via the service-role
  // client (tenant-scoped). Consent is already re-verified above.
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
};
