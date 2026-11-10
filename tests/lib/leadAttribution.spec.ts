import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyChannel,
  cleanReferrerHost,
  cleanTag,
  countryOf,
  deviceClassOf,
  isServicePage,
  landingPathFrom,
  leadAttribution,
} from '@/lib/crm/attribution';
import {
  FIRST_TOUCH_KEY,
  firstTouchOf,
  readFirstTouch,
  recordFirstTouch,
} from '@/lib/client/attribution';
import { analyticsConsent, attributionConsent } from '@/lib/client/analytics';
import { ATTRIBUTION_CONSENT_VERSION, CONSENT_VERSION } from '@consent/gate';
import { LeadInputSchema } from '@schemas/lead';
import { consentCookieHeader } from '../e2e/consentCookie';

// Lead attribution (Admin v2 C13, crm.md §7.3; HELD for O-11). The server's half records
// nothing without analytics consent (hasConsent, the gate of record), takes the landing path
// from the request alone, and keeps each value only in its bounded shape; the browser's half
// keeps the session's first touch only with consent and clears it without.

const HOST = 'site.example.test';

function request(headers: Record<string, string> = {}, cf?: Record<string, unknown>): Request {
  const req = new Request(`https://${HOST}/api/contact`, {
    method: 'POST',
    headers: { host: HOST, ...headers },
  });
  if (cf) Object.defineProperty(req, 'cf', { value: cf });
  return req;
}

const YES = consentCookieHeader({ analytics: true });
const NO = consentCookieHeader({ analytics: false });

describe('the gate: nothing without analytics consent', () => {
  const everything = {
    referer: `https://${HOST}/services/logo?utm_source=x`,
    'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile',
  };
  const touch = { referrerHost: 'www.google.com', utmSource: 'google', utmMedium: 'cpc' };

  it('no consent cookie: null, whatever the browser sent', () => {
    expect(leadAttribution(request(everything, { country: 'SA' }), touch)).toBeNull();
  });

  it('analytics refused: null', () => {
    expect(
      leadAttribution(request({ ...everything, cookie: NO }, { country: 'SA' }), touch),
    ).toBeNull();
  });

  it('a cookie out of shape counts as no consent', () => {
    const forged = `__Host-consent=${encodeURIComponent(JSON.stringify({ analytics: true }))}`;
    expect(leadAttribution(request({ ...everything, cookie: forged }), touch)).toBeNull();
  });

  it('with consent: every column, cleaned, and the channel', () => {
    expect(
      leadAttribution(request({ ...everything, cookie: YES }, { country: 'SA' }), touch),
    ).toEqual({
      landing_path: '/services/logo',
      referrer_host: 'www.google.com',
      utm_source: 'google',
      utm_medium: 'cpc',
      device_class: 'mobile',
      country: 'SA',
      channel: 'paid',
    });
  });

  it('with consent and nothing to say: only the channel, direct', () => {
    expect(leadAttribution(request({ cookie: YES }), undefined)).toEqual({ channel: 'direct' });
  });
});

describe('the consent must be given under the current notice (C13 review: S1, COR-1)', () => {
  // A yes given to an older notice, which the banner is asking about again, records nothing,
  // as the GA4 loader treats it (public/scripts/ga4.js); raising CONSENT_VERSION is the
  // re-consent step register row L-C13-2 relies on.
  const touch = { utmSource: 'google', utmMedium: 'cpc' };
  const at = (v: number) => consentCookieHeader({ analytics: true }, v);
  const value = (header: string) => header.slice(header.indexOf('=') + 1);

  it('the attribution version is never above the current one (else nothing would ever record)', () => {
    expect(ATTRIBUTION_CONSENT_VERSION).toBeLessThanOrEqual(CONSENT_VERSION);
  });

  it('server: an older or a newer version records nothing; the current one records', () => {
    for (const v of [CONSENT_VERSION - 1, CONSENT_VERSION + 1]) {
      expect(
        leadAttribution(request({ cookie: at(v) }, { country: 'SA' }), touch),
        `v=${v}`,
      ).toBeNull();
    }
    expect(leadAttribution(request({ cookie: at(CONSENT_VERSION) }), touch)?.channel).toBe('paid');
  });

  it('browser: a yes under an older notice is no consent for attribution', () => {
    // The first-party page views still count a yes under any version; attribution does not.
    expect(analyticsConsent(at(CONSENT_VERSION - 1))).toBe(true);
    expect(attributionConsent(at(CONSENT_VERSION - 1))).toBe(false);
    expect(attributionConsent(at(CONSENT_VERSION + 1))).toBe(false);
    expect(attributionConsent(at(CONSENT_VERSION))).toBe(true);
    expect(attributionConsent(consentCookieHeader({ analytics: false }))).toBe(false);
    expect(attributionConsent('')).toBe(false);
    // Among other cookies, as document.cookie lists them.
    expect(attributionConsent(`a=1; ${at(CONSENT_VERSION)}`)).toBe(true);
    expect(attributionConsent(`a=1; __Host-consent=${value(at(CONSENT_VERSION - 1))}`)).toBe(false);
  });
});

describe('the landing path is the server’s', () => {
  it('the path of a same-origin Referer, without its query or fragment', () => {
    expect(landingPathFrom(`https://${HOST}/contact?email=a%40b.test#inquiry`, HOST)).toBe(
      '/contact',
    );
    expect(landingPathFrom(`https://${HOST}/ar/services/logo`, HOST)).toBe('/ar/services/logo');
  });

  it('another origin, a bad scheme, no Referer or no Host: no path', () => {
    expect(landingPathFrom('https://evil.example.test/contact', HOST)).toBeUndefined();
    expect(landingPathFrom(`ftp://${HOST}/contact`, HOST)).toBeUndefined();
    expect(landingPathFrom('not a url', HOST)).toBeUndefined();
    expect(landingPathFrom(null, HOST)).toBeUndefined();
    expect(landingPathFrom(`https://${HOST}/contact`, null)).toBeUndefined();
  });

  it('a path that could carry an address or a phone number, or is too long: no path', () => {
    expect(landingPathFrom(`https://${HOST}/x/a@b.test`, HOST)).toBeUndefined();
    expect(landingPathFrom(`https://${HOST}/x/0501234567`, HOST)).toBeUndefined();
    expect(landingPathFrom(`https://${HOST}/${'a'.repeat(200)}`, HOST)).toBeUndefined();
  });

  it('an encoded @ or a phone number split by separators: no path (C13 review S3)', () => {
    expect(landingPathFrom(`https://${HOST}/contact/someone%40mail.com`, HOST)).toBeUndefined();
    expect(landingPathFrom(`https://${HOST}/contact/050-123-4567`, HOST)).toBeUndefined();
    expect(landingPathFrom(`https://${HOST}/contact/(050)123.4567`, HOST)).toBeUndefined();
    // An ordinary page keeps its path, digits and all.
    expect(landingPathFrom(`https://${HOST}/services/3d-design`, HOST)).toBe('/services/3d-design');
  });

  it('the client cannot supply it: a landing path in the body is not read', () => {
    // The attribution object is strict: an extra key drops the whole object (never a 422),
    // and a top-level key is not in the schema at all.
    const parsed = LeadInputSchema.parse({
      name: 'A',
      email: 'a@example.test',
      message: 'hi',
      landingPath: '/evil',
      attribution: { landingPath: '/evil', utmSource: 'x' },
    });
    expect(parsed.attribution).toBeUndefined();
    expect(parsed).not.toHaveProperty('landingPath');
    const columns = leadAttribution(
      request({ cookie: YES, referer: `https://${HOST}/contact` }),
      parsed.attribution,
    );
    expect(columns?.landing_path).toBe('/contact');
  });

  it('an attribution object out of shape is dropped, never a 422', () => {
    const result = LeadInputSchema.safeParse({
      name: 'A',
      email: 'a@example.test',
      message: 'hi',
      attribution: { utmSource: 'x'.repeat(5000) },
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.attribution).toBeUndefined();
  });
});

describe('each value in its bounded shape, or dropped', () => {
  it('the referrer: a host name in ASCII, never a URL, never this site', () => {
    expect(cleanReferrerHost('WWW.Google.COM', HOST)).toBe('www.google.com');
    expect(cleanReferrerHost('https://www.google.com/search?q=x', HOST)).toBeUndefined();
    expect(cleanReferrerHost('user@evil.test', HOST)).toBeUndefined();
    expect(cleanReferrerHost('evil.test:8080', HOST)).toBeUndefined();
    expect(cleanReferrerHost('localhost', HOST)).toBeUndefined();
    expect(cleanReferrerHost(HOST, HOST)).toBeUndefined();
    expect(cleanReferrerHost(`www.${HOST}`, HOST)).toBeUndefined();
    expect(cleanReferrerHost('مثال.example', HOST)).toMatch(/^xn--/);
    expect(cleanReferrerHost(undefined, HOST)).toBeUndefined();
  });

  it('the referrer is never an IP address, in any spelling (C13 review S3)', () => {
    expect(cleanReferrerHost('192.168.1.5', HOST)).toBeUndefined();
    expect(cleanReferrerHost('3232235777', HOST)).toBeUndefined(); // 192.168.1.1 as one integer
    expect(cleanReferrerHost('0xc0.0xa8.1.1', HOST)).toBeUndefined();
    expect(cleanReferrerHost('[::1]', HOST)).toBeUndefined();
    expect(cleanReferrerHost('a1.example2.com', HOST)).toBe('a1.example2.com');
  });

  it('a tag: a lower-case slug of at most 64, never an address or a phone number', () => {
    expect(cleanTag(' Spring Launch ')).toBe('spring-launch');
    expect(cleanTag('a'.repeat(64))).toBe('a'.repeat(64));
    expect(cleanTag('a'.repeat(65))).toBeUndefined();
    expect(cleanTag('someone@example.test')).toBeUndefined();
    expect(cleanTag('call-0501234567')).toBeUndefined();
    expect(cleanTag('call-050-123-4567')).toBeUndefined();
    expect(cleanTag('966.50.123.4567')).toBeUndefined();
    expect(cleanTag('spring_launch-2026.v2')).toBe('spring_launch-2026.v2');
    expect(cleanTag('حملة')).toBeUndefined();
    expect(cleanTag('')).toBeUndefined();
  });

  it('the device class, from the hint or the User-Agent; the User-Agent never kept', () => {
    const h = (headers: Record<string, string>) => new Headers(headers);
    expect(deviceClassOf(h({ 'sec-ch-ua-mobile': '?1' }))).toBe('mobile');
    expect(deviceClassOf(h({ 'sec-ch-ua-mobile': '?0' }))).toBe('desktop');
    expect(deviceClassOf(h({ 'user-agent': 'Mozilla/5.0 (iPad; CPU OS 17_0)' }))).toBe('tablet');
    expect(deviceClassOf(h({ 'user-agent': 'Mozilla/5.0 (Linux; Android 14; Tab) Safari' }))).toBe(
      'tablet',
    );
    expect(
      deviceClassOf(h({ 'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel) Mobile Safari' })),
    ).toBe('mobile');
    expect(deviceClassOf(h({ 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }))).toBe(
      'desktop',
    );
    expect(deviceClassOf(h({}))).toBeUndefined();
  });

  it('the country: a two-letter code from Cloudflare, never anything else', () => {
    expect(countryOf(request({}, { country: 'SA' }))).toBe('SA');
    expect(countryOf(request({}, { country: 'XX' }))).toBeUndefined();
    expect(countryOf(request({}, { country: 'T1' }))).toBeUndefined();
    expect(countryOf(request({}, { country: 'Riyadh' }))).toBeUndefined();
    expect(countryOf(request({}, { city: 'Riyadh' }))).toBeUndefined();
    expect(countryOf(request())).toBeUndefined();
  });

  it('the country survives Astro rebuilding the request (C13 review COR-5)', () => {
    // astro/dist/core/fetch/fetch-state.js rebuilds the request with `new Request(url, request)`
    // on its forwarded-host path; outside workerd that drops `cf`. Cloudflare's CF-IPCountry
    // header survives it.
    const original = request({ 'cf-ipcountry': 'SA' }, { country: 'SA' });
    const rebuilt = new Request(`https://${HOST}/api/contact`, original);
    expect((rebuilt as Request & { cf?: unknown }).cf).toBeUndefined();
    expect(countryOf(rebuilt)).toBe('SA');
    expect(countryOf(request({ 'cf-ipcountry': 'XX' }))).toBeUndefined();
    expect(countryOf(request({ 'cf-ipcountry': 'Riyadh' }))).toBeUndefined();
    // `cf` wins where both are present.
    expect(countryOf(request({ 'cf-ipcountry': 'AE' }, { country: 'SA' }))).toBe('SA');
  });
});

describe('the channel', () => {
  it('a medium first', () => {
    expect(classifyChannel({ medium: 'cpc', referrerHost: 'www.facebook.com' })).toBe('paid');
    expect(classifyChannel({ medium: 'paid_social' })).toBe('paid');
    expect(classifyChannel({ medium: 'newsletter' })).toBe('email');
    expect(classifyChannel({ medium: 'social' })).toBe('social');
    expect(classifyChannel({ medium: 'organic' })).toBe('organic');
    expect(classifyChannel({ medium: 'referral' })).toBe('referral');
  });

  it('then the referring site', () => {
    expect(classifyChannel({ referrerHost: 'mail.google.com' })).toBe('email');
    expect(classifyChannel({ referrerHost: 'www.google.com.sa' })).toBe('organic');
    expect(classifyChannel({ referrerHost: 'www.bing.com' })).toBe('organic');
    expect(classifyChannel({ referrerHost: 'l.instagram.com' })).toBe('social');
    expect(classifyChannel({ referrerHost: 't.co' })).toBe('social');
    expect(classifyChannel({ referrerHost: 'blog.example.test' })).toBe('referral');
    expect(classifyChannel({ medium: 'weird', referrerHost: 'www.google.com' })).toBe('organic');
  });

  it('consent given after the first page: unknown, never direct (C13 review COR-2)', () => {
    expect(classifyChannel({ lateConsent: true })).toBe('unknown');
    expect(classifyChannel({ lateConsent: true, medium: 'cpc' })).toBe('paid');
    expect(classifyChannel({ lateConsent: true, source: 'google' })).toBe('organic');
    const parsed = LeadInputSchema.parse({
      name: 'A',
      email: 'a@example.test',
      message: 'hi',
      attribution: { lateConsent: true },
    });
    expect(leadAttribution(request({ cookie: YES }), parsed.attribution)).toEqual({
      channel: 'unknown',
    });
  });

  it('then the source, and direct with nothing', () => {
    expect(classifyChannel({ source: 'instagram' })).toBe('social');
    expect(classifyChannel({ source: 'google' })).toBe('organic');
    expect(classifyChannel({ source: 'partner' })).toBe('referral');
    expect(classifyChannel({ medium: 'weird' })).toBe('referral');
    expect(classifyChannel({})).toBe('direct');
  });
});

it('a service page is /services/<slug>, in either language', () => {
  expect(isServicePage('/services/logo')).toBe(true);
  expect(isServicePage('/ar/services/logo/')).toBe(true);
  expect(isServicePage('/services')).toBe(false);
  expect(isServicePage('/services/logo/extra')).toBe(false);
  expect(isServicePage(undefined)).toBe(false);
});

// ---- The browser's first touch ------------------------------------------------------------------

describe('the first touch of a page', () => {
  it('the campaign tags and another site’s host, never a path or a query', () => {
    expect(
      firstTouchOf(
        `https://${HOST}/services?utm_source=Google&utm_medium=cpc&utm_campaign=spring&gclid=abc`,
        'https://www.google.com/search?q=braiin',
      ),
    ).toEqual({
      referrerHost: 'www.google.com',
      utmSource: 'Google',
      utmMedium: 'cpc',
      utmCampaign: 'spring',
    });
  });

  it('this site as referrer: no host, and the arrival was not seen (COR-2)', () => {
    // The visitor allowed analytics on a page they reached from inside the site.
    expect(
      firstTouchOf(`https://${HOST}/about`, `https://${HOST}/services/logo?utm_medium=cpc`),
    ).toEqual({ lateConsent: true });
  });

  it('an unreadable referrer, or none: no host', () => {
    expect(firstTouchOf(`https://${HOST}/`, 'android-app://com.example')).toEqual({});
    expect(firstTouchOf(`https://${HOST}/`, '')).toEqual({});
    expect(firstTouchOf('nonsense', '')).toEqual({});
  });

  it('a tag is cut to the schema bound', () => {
    expect(
      firstTouchOf(`https://${HOST}/?utm_campaign=${'a'.repeat(300)}`, '').utmCampaign,
    ).toHaveLength(200);
  });
});

describe('the first touch in sessionStorage, with consent only', () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const page = (href: string, referrer = '') => {
    vi.stubGlobal('sessionStorage', storage);
    vi.stubGlobal('location', { href });
    vi.stubGlobal('document', { referrer });
  };
  afterEach(() => {
    store.clear();
    vi.unstubAllGlobals();
  });

  it('without consent nothing is written, and nothing is read', () => {
    page(`https://${HOST}/?utm_source=x`, 'https://www.google.com/');
    recordFirstTouch(false);
    expect(store.has(FIRST_TOUCH_KEY)).toBe(false);
    store.set(FIRST_TOUCH_KEY, JSON.stringify({ utmSource: 'x' }));
    expect(readFirstTouch(false)).toBeUndefined();
  });

  it('with consent the first page is kept, once; a later page does not replace it', () => {
    page(`https://${HOST}/?utm_source=first`, 'https://www.google.com/');
    recordFirstTouch(true);
    page(`https://${HOST}/contact?utm_source=second`);
    recordFirstTouch(true);
    expect(readFirstTouch(true)).toEqual({ referrerHost: 'www.google.com', utmSource: 'first' });
  });

  it('the late-consent marker is kept and read back', () => {
    page(`https://${HOST}/about`, `https://${HOST}/`);
    recordFirstTouch(true);
    expect(readFirstTouch(true)).toEqual({ lateConsent: true });
  });

  it('a withdrawn consent removes it', () => {
    page(`https://${HOST}/?utm_source=x`);
    recordFirstTouch(true);
    expect(store.has(FIRST_TOUCH_KEY)).toBe(true);
    recordFirstTouch(false);
    expect(store.has(FIRST_TOUCH_KEY)).toBe(false);
  });

  it('a stored value out of shape gives only what fits; blocked storage gives nothing', () => {
    page(`https://${HOST}/`);
    store.set(FIRST_TOUCH_KEY, JSON.stringify({ utmSource: 7, utmMedium: 'cpc', other: 'x' }));
    expect(readFirstTouch(true)).toEqual({ utmMedium: 'cpc' });
    store.set(FIRST_TOUCH_KEY, '{');
    expect(readFirstTouch(true)).toBeUndefined();
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() => recordFirstTouch(true)).not.toThrow();
    expect(() => recordFirstTouch(false)).not.toThrow();
    expect(readFirstTouch(true)).toBeUndefined();
  });
});
