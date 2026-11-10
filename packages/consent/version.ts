// The consent versions, with no dependency (no zod), so the public client bundle can read them:
// src/lib/client/analytics.ts compares the cookie's `v` with them in the browser, and
// packages/consent/gate.ts re-exports them for the server.

/** Bump when the cookie inventory / lawful-basis copy changes → re-prompt. */
export const CONSENT_VERSION = 1;

/**
 * Lead attribution (Admin v2 C13; HELD for O-11): the first consent version whose notice names
 * attribution. A yes counts for attribution only when it was given under the CURRENT notice
 * (`v === CONSENT_VERSION`: while the banner is asking again, an older yes records nothing) and
 * under a notice at least this new. Set at the merge to the version the lawyer approves
 * (register L-C13-2): if a choice made before the notice update must be asked again, the merge
 * raises CONSENT_VERSION and this together, and attribution records nothing until the visitor
 * chooses again. tests/lib/leadAttribution.spec.ts holds it at or below CONSENT_VERSION.
 */
export const ATTRIBUTION_CONSENT_VERSION = 1;

/** True when a consent choice made under version `v` covers lead attribution. */
export function attributionVersionOk(v: unknown): boolean {
  return (
    typeof v === 'number' &&
    Number.isInteger(v) &&
    v === CONSENT_VERSION &&
    v >= ATTRIBUTION_CONSENT_VERSION
  );
}
