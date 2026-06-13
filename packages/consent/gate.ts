import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// THE SINGLE PDPL CONSENT GATE (CLAUDE.md §7 "Consent (PDPL)").
// Every consent-dependent surface MUST route through hasConsent():
//   - first-party telemetry ingest        (analytics)
//   - the RUM web-vitals beacon            (analytics)
//   - GA4 injection                        (analytics)
//   - the third-party video facade click   (functional is always on; embeds need functional)
// Default DENY. `functional` (strictly necessary) is always granted.
// ─────────────────────────────────────────────────────────────────────────────

export const CONSENT_CATEGORIES = ['functional', 'analytics', 'marketing'] as const;
export type ConsentCategory = (typeof CONSENT_CATEGORIES)[number];

export const CONSENT_COOKIE = '__Host-consent';
/** Bump when the cookie inventory / lawful-basis copy changes → re-prompt. */
export const CONSENT_VERSION = 1;

export const ConsentStateSchema = z.object({
  functional: z.literal(true),
  analytics: z.boolean(),
  marketing: z.boolean(),
  v: z.number().int().nonnegative(),
  ts: z.number().int().nonnegative(),
});
export type ConsentState = z.infer<typeof ConsentStateSchema>;

export const DEFAULT_CONSENT: ConsentState = {
  functional: true,
  analytics: false,
  marketing: false,
  v: 0,
  ts: 0,
};

export function parseConsentCookie(raw: string | null | undefined): ConsentState {
  if (!raw) return DEFAULT_CONSENT;
  try {
    const parsed = ConsentStateSchema.safeParse(JSON.parse(decodeURIComponent(raw)));
    return parsed.success ? parsed.data : DEFAULT_CONSENT;
  } catch {
    return DEFAULT_CONSENT;
  }
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** THE gate. `functional` is always true; everything else defaults denied. */
export function hasConsent(req: Request, category: ConsentCategory): boolean {
  if (category === 'functional') return true;
  return parseConsentCookie(readCookie(req, CONSENT_COOKIE))[category] === true;
}

/**
 * Cookie attributes for persisting consent. `__Host-` ⇒ Secure + Path=/ + no Domain.
 * NOT HttpOnly: the client consent banner reads/updates it; consent state is not a
 * secret. The server gate also reads it. `SameSite=Lax` is sufficient.
 */
export function consentCookieAttributes(): string {
  return 'Path=/; Secure; SameSite=Lax; Max-Age=15552000'; // 180 days
}
