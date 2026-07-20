import { describe, it, expect } from 'vitest';
import {
  hasConsent,
  parseConsentCookie,
  consentCookieAttributes,
  DEFAULT_CONSENT,
  CONSENT_COOKIE,
  CONSENT_CATEGORIES,
} from '@consent/gate';

// The single PDPL gate (CLAUDE.md §7). It had no test, which is a strange place for a
// coverage hole: every failure mode here is "telemetry collected without consent", i.e.
// the exact thing PDPL penalises. Default-deny is asserted from several angles below.

const reqWith = (cookie?: string) =>
  new Request('https://x.com/', cookie ? { headers: { cookie } } : undefined);

const cookieFor = (state: object) =>
  `${CONSENT_COOKIE}=${encodeURIComponent(JSON.stringify(state))}`;

const granted = { functional: true, analytics: true, marketing: true, v: 1, ts: 1750000000 };

describe('hasConsent — default deny', () => {
  it('denies analytics and marketing with NO cookie', () => {
    const req = reqWith();
    expect(hasConsent(req, 'analytics')).toBe(false);
    expect(hasConsent(req, 'marketing')).toBe(false);
  });

  it('always grants functional (strictly necessary), even with no cookie', () => {
    expect(hasConsent(reqWith(), 'functional')).toBe(true);
  });

  it('denies every non-functional category by default', () => {
    const req = reqWith();
    for (const c of CONSENT_CATEGORIES.filter((x) => x !== 'functional')) {
      expect(hasConsent(req, c)).toBe(false);
    }
  });

  it('grants only what the cookie actually grants', () => {
    const req = reqWith(cookieFor({ ...granted, marketing: false }));
    expect(hasConsent(req, 'analytics')).toBe(true);
    expect(hasConsent(req, 'marketing')).toBe(false);
  });
});

describe('hasConsent — hostile / malformed cookies fall back to denied', () => {
  const cases: [string, string][] = [
    ['garbage', `${CONSENT_COOKIE}=not-json`],
    ['empty value', `${CONSENT_COOKIE}=`],
    ['wrong types', cookieFor({ functional: true, analytics: 'yes', marketing: 1, v: 1, ts: 1 })],
    ['missing fields', cookieFor({ analytics: true })],
    ['a JSON array', `${CONSENT_COOKIE}=${encodeURIComponent('[1,2,3]')}`],
    ['literal null', `${CONSENT_COOKIE}=${encodeURIComponent('null')}`],
    ['functional forged false', cookieFor({ ...granted, functional: false })],
  ];

  for (const [label, cookie] of cases) {
    it(`denies analytics when the cookie is ${label}`, () => {
      expect(hasConsent(reqWith(cookie), 'analytics')).toBe(false);
    });
  }

  it('does not throw on a malformed percent-encoding', () => {
    expect(() => hasConsent(reqWith(`${CONSENT_COOKIE}=%E0%A4%A`), 'analytics')).not.toThrow();
    expect(hasConsent(reqWith(`${CONSENT_COOKIE}=%E0%A4%A`), 'analytics')).toBe(false);
  });
});

describe('cookie parsing', () => {
  it('picks the right cookie out of a crowded header', () => {
    const header = `foo=bar; ${CONSENT_COOKIE}=${encodeURIComponent(JSON.stringify(granted))}; baz=qux`;
    expect(hasConsent(reqWith(header), 'analytics')).toBe(true);
  });

  it('does not match a cookie whose name merely ENDS WITH the real one', () => {
    const header = `evil-${CONSENT_COOKIE}=${encodeURIComponent(JSON.stringify(granted))}`;
    expect(hasConsent(reqWith(header), 'analytics')).toBe(false);
  });

  it('returns the deny-by-default state for null/undefined input', () => {
    expect(parseConsentCookie(null)).toEqual(DEFAULT_CONSENT);
    expect(parseConsentCookie(undefined)).toEqual(DEFAULT_CONSENT);
    expect(DEFAULT_CONSENT.analytics).toBe(false);
    expect(DEFAULT_CONSENT.marketing).toBe(false);
  });

  it('preserves the version so a policy change can force a re-prompt', () => {
    expect(parseConsentCookie(encodeURIComponent(JSON.stringify(granted))).v).toBe(1);
  });
});

describe('consentCookieAttributes', () => {
  const attrs = consentCookieAttributes();

  it('satisfies the __Host- prefix rules: Secure + Path=/ + no Domain', () => {
    expect(attrs).toContain('Secure');
    expect(attrs).toContain('Path=/');
    expect(attrs).not.toContain('Domain=');
  });

  it('is SameSite=Lax and not HttpOnly (the banner must read it)', () => {
    expect(attrs).toContain('SameSite=Lax');
    expect(attrs).not.toContain('HttpOnly');
  });

  it('expires — consent is not indefinite under PDPL', () => {
    const maxAge = Number(/Max-Age=(\d+)/.exec(attrs)?.[1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(60 * 60 * 24 * 365);
  });
});
