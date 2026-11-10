import {
  CONSENT_COOKIE,
  CONSENT_VERSION,
  ConsentStateSchema,
  type ConsentState,
} from '../../packages/consent/gate';

/**
 * A `__Host-consent` cookie header for a request a spec sends itself (Playwright's `request`),
 * in the shape the banner writes and `hasConsent()` accepts. A hand-built cookie that misses a
 * key (`{ analytics: true }` alone) parses as no consent at all, so the endpoint answers as it
 * does to a visitor who never chose, and the spec tests the wrong branch.
 * tests/lib/consentCookieHelper.spec.ts holds every e2e spec to this helper.
 */
export function consentCookieHeader(
  choice: Partial<Pick<ConsentState, 'analytics' | 'marketing'>>,
  /** The notice version the choice was made under; an older one is a choice the banner asks again. */
  version: number = CONSENT_VERSION,
): string {
  const state = ConsentStateSchema.parse({
    functional: true,
    analytics: choice.analytics ?? false,
    marketing: choice.marketing ?? false,
    v: version,
    ts: Date.now(),
  });
  return `${CONSENT_COOKIE}=${encodeURIComponent(JSON.stringify(state))}`;
}
