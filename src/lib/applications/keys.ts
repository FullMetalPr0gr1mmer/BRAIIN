// Key material for the Join path, derived from LEAD_PII_ENC_KEY — so the careers page adds
// NO new secret (a new Worker secret is seven hand-wired places and an ops step).
//
// Each purpose gets its own label, so one root key yields independent keys: an applicant's
// e-mail is not encrypted under the same key as a lead's, and a rate-limit HMAC never
// equals an encryption key. The derivation is the input to `encryptPII`'s own SHA-256
// step (src/lib/crypto/pii.ts) — distinct inputs, distinct keys. A separate secret would
// buy compartmentalisation against a leak of ONE Worker secret, but every secret of this
// Worker leaks together (they are read by the same code), so it would buy nothing real.
//
// Pure (no astro:env import) so the endpoint, the admin and the tests share it.

export const APPLICANT_PII_LABEL = 'applicant/v1';
export const RATE_LIMIT_LABEL = 'ratelimit/v1';

/** `base` + NUL + `label`. NUL cannot occur in an env secret, so labels cannot collide. */
export function labelledKeyMaterial(base: string, label: string): string {
  return `${base}\u0000${label}`;
}
