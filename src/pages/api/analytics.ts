import type { APIRoute } from 'astro';
import { hasConsent } from '@consent/gate';
import { AnalyticsEventSchema } from '@schemas/analytics';
import { isSameOrigin } from '@/lib/http/csrf';
import { recordAnalyticsEvent } from '@/lib/data/telemetry';

// First-party analytics ingest — the canonical source (CLAUDE.md Pillar 4).
//
// The client only beacons with analytics consent; this RE-CHECKS it server-side and
// drops silently otherwise. Two independent checks because the client-side one is a
// courtesy (it saves a request) and the server-side one is the control: a beacon can
// be replayed by anything, and consent is a legal position rather than a UI preference.
//
// A dropped beacon answers 204, not 403. The visitor declined tracking — that is the
// system working, and an error status would light up the error reporter on every page
// view by every privacy-conscious visitor.

export const prerender = false;

const NO_STORE = { 'cache-control': 'private, no-store' } as const;

export const POST: APIRoute = async ({ request }) => {
  // Astro's `security.checkOrigin` only covers form-like content types, so a
  // cross-origin JSON POST needs this explicit check. sendBeacon from our own pages is
  // same-origin and unaffected.
  if (!isSameOrigin(request.headers.get('origin'), request.headers.get('host'))) {
    return new Response('bad origin', { status: 403, headers: NO_STORE });
  }

  if (!hasConsent(request, 'analytics')) {
    return new Response(null, { status: 204, headers: NO_STORE });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response('bad request', { status: 400, headers: NO_STORE });
  }

  const parsed = AnalyticsEventSchema.safeParse(body);
  if (!parsed.success) return new Response('invalid', { status: 422, headers: NO_STORE });

  // Fire-and-forget: the beacon's caller is `navigator.sendBeacon`, which neither reads
  // nor retries the response. Awaiting the insert would only delay the 204.
  await recordAnalyticsEvent(parsed.data);
  return new Response(null, { status: 204, headers: NO_STORE });
};
