import { readFileSync } from 'node:fs';
import { runInContext, createContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  CONSENT_COOKIE,
  CONSENT_VERSION,
  ConsentStateSchema,
  hasConsent,
  parseConsentCookie,
} from '@consent/gate';
import { GA4_CSP_SOURCES } from '@/lib/http/securityHeaders';

// The GA4 loader (Admin v2 U15, public/scripts/ga4.js), run as the browser runs it: the file
// itself, in a fresh V8 context, over a small fake of the page (the script tag and its data
// attributes, the cookie jar, the head, the document's and the window's events, sendBeacon).
//
//   - nothing from Google is requested, and no dataLayer exists, before analytics consent;
//   - its reading of the consent cookie is the server gate's (hasConsent), at the current
//     consent version, cookie by cookie;
//   - on consent: one gtag.js request, consent mode (analytics granted, every ad signal
//     denied), the privacy settings, page addresses without their query;
//   - on withdrawal: Google's off switch, read from the cookie on every ask (so a no given in
//     another window stops the next hit at once); consent mode denied, no second request, the
//     _ga cookies cleared on the host and its parents; a page loaded without consent clears them;
//   - the Report-Only cycle: a refused Google address is reported (the directive, the origin
//     and the path, never the query), at most five a page.

const SOURCE = readFileSync('public/scripts/ga4.js', 'utf8');
const ID = 'G-TEST1234';

interface Page {
  appended: { src: string; async: boolean }[];
  writes: string[];
  beacons: { url: string; body: unknown }[];
  jar: Map<string, string>;
  dataLayer: () => unknown[][] | undefined;
  off: () => unknown;
  setConsent: (state: Record<string, unknown> | null) => void;
  dispatch: (type: string, event?: Record<string, unknown>) => void;
  dispatchWindow: (type: string, event?: Record<string, unknown>) => void;
  /** The tab shown again or hidden (`document.visibilityState`, then `visibilitychange`). */
  show: (visible: boolean) => void;
  /** The page finishes loading (`document.readyState`, then the window's `load`). */
  loaded: () => void;
}

interface Options {
  id?: string | null;
  version?: string | null;
  cookies?: Record<string, string>;
  href?: string;
  referrer?: string;
  /** The script runs while the page is still loading (a deferred script always does). */
  loading?: boolean;
}

/** `name=value` for the consent cookie, as the banner writes it (or a raw value). */
const consentValue = (state: Record<string, unknown>) => encodeURIComponent(JSON.stringify(state));
const choice = (analytics: boolean, v = CONSENT_VERSION) =>
  ConsentStateSchema.parse({ functional: true, analytics, marketing: false, v, ts: 1_700_000_000 });

function load(options: Options = {}): Page {
  const {
    id = ID,
    version = String(CONSENT_VERSION),
    cookies = {},
    href = 'https://www.example.test/services/logo?utm_source=x&email=a%40b.c#top',
    referrer = 'https://www.example.test/?q=secret',
    loading = false,
  } = options;
  const jar = new Map(Object.entries(cookies));
  const writes: string[] = [];
  const appended: { src: string; async: boolean }[] = [];
  const beacons: { url: string; body: unknown }[] = [];
  const docListeners = new Map<string, ((e: unknown) => void)[]>();
  const winListeners = new Map<string, ((e: unknown) => void)[]>();
  const attrs: Record<string, string | null> = {
    'data-ga4-id': id,
    'data-consent-version': version,
  };
  const url = new URL(href);
  const document = {
    currentScript: { getAttribute: (name: string) => attrs[name] ?? null },
    referrer,
    visibilityState: 'visible' as 'visible' | 'hidden',
    readyState: (loading ? 'interactive' : 'complete') as 'interactive' | 'complete',
    get cookie() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    set cookie(line: string) {
      writes.push(line);
      const [pair = '', ...attributes] = line.split(';').map((p) => p.trim());
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      if (attributes.some((a) => /^max-age=0$/i.test(a))) jar.delete(name);
      else jar.set(name, pair.slice(eq + 1));
    },
    createElement: (tag: string) => {
      expect(tag).toBe('script');
      return { async: false, src: '' };
    },
    head: { appendChild: (el: { src: string; async: boolean }) => appended.push({ ...el }) },
    addEventListener: (type: string, fn: (e: unknown) => void) =>
      docListeners.set(type, [...(docListeners.get(type) ?? []), fn]),
  };
  const context = createContext({
    document,
    location: { href: url.href, hostname: url.hostname, pathname: url.pathname },
    navigator: {
      sendBeacon: (to: string, body: string) => {
        beacons.push({ url: to, body: JSON.parse(body) });
        return true;
      },
    },
    addEventListener: (type: string, fn: (e: unknown) => void) =>
      winListeners.set(type, [...(winListeners.get(type) ?? []), fn]),
    URL,
  });
  (context as Record<string, unknown>)['window'] = context;
  runInContext(SOURCE, context);
  const global = context as Record<string, unknown>;
  return {
    appended,
    writes,
    beacons,
    jar,
    dataLayer: () => {
      const layer = global['dataLayer'] as ArrayLike<ArrayLike<unknown>> | undefined;
      return layer === undefined
        ? undefined
        : (JSON.parse(
            JSON.stringify(Array.from(layer, (entry) => Array.from(entry))),
          ) as unknown[][]);
    },
    off: () => global[`ga-disable-${ID}`],
    setConsent: (state) => {
      if (state === null) jar.delete(CONSENT_COOKIE);
      else jar.set(CONSENT_COOKIE, consentValue(state));
    },
    dispatch: (type, event = {}) => {
      for (const fn of docListeners.get(type) ?? []) fn(event);
    },
    dispatchWindow: (type, event = {}) => {
      for (const fn of winListeners.get(type) ?? []) fn(event);
    },
    show: (visible) => {
      document.visibilityState = visible ? 'visible' : 'hidden';
      for (const fn of docListeners.get('visibilitychange') ?? []) fn({});
    },
    loaded: () => {
      document.readyState = 'complete';
      for (const fn of winListeners.get('load') ?? []) fn({});
    },
  };
}

const GTAG = `https://www.googletagmanager.com/gtag/js?id=${ID}`;
const GA_COOKIES = { _ga: 'GA1.1.111.222', [`_ga_${ID.slice(2)}`]: 'GS1.1.333' };

describe('before analytics consent', () => {
  it('requests nothing from Google and builds no dataLayer, with no choice made', () => {
    const page = load();
    expect(page.appended).toEqual([]);
    expect(page.dataLayer()).toBeUndefined();
    expect(page.beacons).toEqual([]);
  });

  it('nor after a refusal, or a choice made under another consent version', () => {
    for (const cookies of [
      { [CONSENT_COOKIE]: consentValue(choice(false)) },
      { [CONSENT_COOKIE]: consentValue(choice(true, CONSENT_VERSION + 1)) },
      { [CONSENT_COOKIE]: consentValue(choice(true, 0)) },
    ]) {
      const page = load({ cookies });
      expect(page.appended).toEqual([]);
      expect(page.dataLayer()).toBeUndefined();
    }
  });

  it('clears the _ga cookies a page finds without consent, on this host and its parents', () => {
    const page = load({ cookies: { ...GA_COOKIES, other: 'kept' } });
    expect([...page.jar.keys()]).toEqual(['other']);
    for (const name of Object.keys(GA_COOKIES)) {
      expect(page.writes).toEqual(
        expect.arrayContaining([
          `${name}=; Max-Age=0; Path=/; SameSite=Lax`,
          `${name}=; Max-Age=0; Path=/; Domain=www.example.test; SameSite=Lax`,
          `${name}=; Max-Age=0; Path=/; Domain=example.test; SameSite=Lax`,
        ]),
      );
    }
    // Never the bare top-level domain, never a cookie it does not name.
    expect(page.writes.some((w) => w.includes('Domain=test;'))).toBe(false);
    expect(page.writes.some((w) => w.startsWith('other='))).toBe(false);
  });

  it('writes no cookie at all when there is none to clear', () => {
    expect(load().writes).toEqual([]);
  });

  it('does nothing for an id or a version its tag should never carry', () => {
    for (const options of [
      { id: 'UA-12345-1' },
      { id: '"><script>' },
      { id: 'g-test1234' },
      { id: null },
      { version: 'one' },
      { version: '-1' },
      { version: null },
    ]) {
      const page = load({ ...options, cookies: { [CONSENT_COOKIE]: consentValue(choice(true)) } });
      expect(page.appended, JSON.stringify(options)).toEqual([]);
      expect(page.dataLayer()).toBeUndefined();
    }
  });
});

describe('its reading of the consent cookie is the gate’s, at the current version', () => {
  const base = { functional: true, analytics: true, marketing: false, v: CONSENT_VERSION, ts: 1 };
  const values: Record<string, string> = {
    granted: consentValue(base),
    refused: consentValue({ ...base, analytics: false }),
    'an older version': consentValue({ ...base, v: CONSENT_VERSION - 1 }),
    'a newer version': consentValue({ ...base, v: CONSENT_VERSION + 1 }),
    'extra keys': consentValue({ ...base, extra: 'kept' }),
    'marketing too': consentValue({ ...base, marketing: true }),
    'no ts': consentValue({ ...base, ts: undefined }),
    'a negative ts': consentValue({ ...base, ts: -1 }),
    'a fractional version': consentValue({ ...base, v: 1.5 }),
    'functional false': consentValue({ ...base, functional: false }),
    'analytics as a string': consentValue({ ...base, analytics: 'true' }),
    'no marketing': consentValue({ ...base, marketing: undefined }),
    'an array': consentValue([base] as unknown as Record<string, unknown>),
    null: 'null',
    'not JSON': 'yes',
    'broken encoding': '%E0%A4%A',
    unencoded: JSON.stringify(base),
    empty: '',
  };

  it.each(Object.keys(values))('%s', (name) => {
    const raw = values[name]!;
    const req = new Request('https://www.example.test/', {
      headers: { cookie: `${CONSENT_COOKIE}=${raw}` },
    });
    const gate = hasConsent(req, 'analytics') && parseConsentCookie(raw).v === CONSENT_VERSION;
    const page = load({ cookies: { [CONSENT_COOKIE]: raw } });
    expect(page.appended.length === 1, `${name}: the gate says ${gate}`).toBe(gate);
  });

  it('the first cookie of the name wins, as the gate reads it', () => {
    // A jar cannot hold two of one name; the header can. Both readers take the first.
    const cookie = `${CONSENT_COOKIE}=${values['refused']}; ${CONSENT_COOKIE}=${values['granted']}`;
    expect(hasConsent(new Request('https://x.test/', { headers: { cookie } }), 'analytics')).toBe(
      false,
    );
    expect(SOURCE).toContain("for (const part of document.cookie.split(';'))");
    expect(SOURCE).toContain(
      'if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();',
    );
  });
});

describe('after analytics consent', () => {
  it('requests gtag.js once, from the host the CSP lists, with consent mode and the privacy settings', () => {
    const page = load({ cookies: { [CONSENT_COOKIE]: consentValue(choice(true)) } });
    expect(page.appended).toEqual([{ src: GTAG, async: true }]);
    // The script-src source is a path (ending in "/", so it matches by prefix).
    expect(GA4_CSP_SOURCES.script.some((source) => GTAG.startsWith(source))).toBe(true);
    const layer = page.dataLayer()!;
    expect(layer[0]).toEqual([
      'consent',
      'default',
      {
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
        analytics_storage: 'denied',
      },
    ]);
    expect(layer[1]).toEqual(['consent', 'update', { analytics_storage: 'granted' }]);
    expect(layer[2]![0]).toBe('js');
    expect(layer[3]).toEqual([
      'config',
      ID,
      {
        cookie_domain: 'none',
        cookie_expires: 15552000,
        cookie_flags: 'SameSite=Lax;Secure',
        allow_google_signals: false,
        allow_ad_personalization_signals: false,
        // Never the query (a campaign tag, an address someone pasted) nor the fragment.
        page_location: 'https://www.example.test/services/logo',
        page_referrer: 'https://www.example.test/',
      },
    ]);
    expect(layer).toHaveLength(4);
    expect(page.off()).toBe(false);
  });

  it('the cookie lifetime is the consent cookie’s own', async () => {
    const { consentCookieAttributes } = await import('@consent/gate');
    expect(consentCookieAttributes()).toContain('Max-Age=15552000');
    expect(SOURCE).toContain('const COOKIE_SECONDS = 15552000;');
  });

  it('sends no referrer when there is none, and only the address when there is', () => {
    const page = load({
      referrer: '',
      cookies: { [CONSENT_COOKIE]: consentValue(choice(true)) },
    });
    expect(page.dataLayer()![3]![2]).not.toHaveProperty('page_referrer');
  });

  it('starts when the banner records a yes mid-visit, and only once', () => {
    const page = load();
    expect(page.appended).toEqual([]);
    page.setConsent(choice(true));
    page.dispatch('consent-updated');
    page.dispatch('consent-updated');
    expect(page.appended).toEqual([{ src: GTAG, async: true }]);
  });
});

describe('gtag.js waits for the page to load', () => {
  it('a yes found while the page is still loading queues at once and asks Google only at load', () => {
    const page = load({ loading: true, cookies: { [CONSENT_COOKIE]: consentValue(choice(true)) } });
    expect(page.dataLayer()!.map((entry) => entry[0])).toEqual([
      'consent',
      'consent',
      'js',
      'config',
    ]);
    expect(page.appended).toEqual([]);
    page.loaded();
    expect(page.appended).toEqual([{ src: GTAG, async: true }]);
    page.loaded();
    expect(page.appended).toHaveLength(1);
  });

  it('a no before load means Google is never asked; a yes again asks once, at load', () => {
    const page = load({ loading: true, cookies: { [CONSENT_COOKIE]: consentValue(choice(true)) } });
    page.setConsent(choice(false));
    page.dispatch('consent-updated');
    page.loaded();
    expect(page.appended).toEqual([]);
    expect(page.off()).toBe(true);
    page.setConsent(choice(true));
    page.dispatch('consent-updated');
    expect(page.appended).toEqual([{ src: GTAG, async: true }]);
    page.dispatch('consent-updated');
    expect(page.appended).toHaveLength(1);
  });

  it('the Report-Only listener starts with the request, not before', () => {
    const page = load({ loading: true, cookies: { [CONSENT_COOKIE]: consentValue(choice(true)) } });
    const refused = {
      blockedURI: 'https://x.google-analytics.com/g',
      effectiveDirective: 'img-src',
    };
    page.dispatch('securitypolicyviolation', refused);
    expect(page.beacons).toEqual([]);
    page.loaded();
    page.dispatch('securitypolicyviolation', refused);
    expect(page.beacons).toHaveLength(1);
  });
});

describe('on withdrawal', () => {
  it('denies consent mode, sets Google’s off switch, clears the cookies, and loads nothing more', () => {
    const page = load({ cookies: { [CONSENT_COOKIE]: consentValue(choice(true)) } });
    // What gtag.js would have set by now.
    for (const [name, value] of Object.entries(GA_COOKIES)) page.jar.set(name, value);
    page.setConsent(choice(false));
    page.dispatch('consent-updated');
    const layer = page.dataLayer()!;
    expect(layer.at(-1)).toEqual([
      'consent',
      'update',
      {
        analytics_storage: 'denied',
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
      },
    ]);
    expect(page.off()).toBe(true);
    expect([...page.jar.keys()]).toEqual([CONSENT_COOKIE]);
    page.dispatch('consent-updated');
    expect(page.appended).toHaveLength(1);
  });

  it('a yes again on the same page resumes without a second request', () => {
    const page = load({ cookies: { [CONSENT_COOKIE]: consentValue(choice(true)) } });
    page.setConsent(choice(false));
    page.dispatch('consent-updated');
    page.setConsent(choice(true));
    page.dispatch('consent-updated');
    expect(page.off()).toBe(false);
    expect(page.dataLayer()!.at(-1)).toEqual([
      'consent',
      'update',
      { analytics_storage: 'granted' },
    ]);
    expect(page.appended).toHaveLength(1);
  });

  it('Google’s off switch reads the cookie each time gtag.js asks, with no event reaching this page', () => {
    // A no given in another window fires nothing here, yet the very next hit must not go:
    // the notice says nothing more is sent from then on.
    const page = load({ cookies: { [CONSENT_COOKIE]: consentValue(choice(true)) } });
    const layer = page.dataLayer()!.length;
    expect(page.off()).toBe(false);
    for (const [state, off] of [
      [choice(false), true],
      [choice(true), false],
      [null, true],
      [choice(true), false],
      [choice(true, CONSENT_VERSION + 1), true],
    ] as const) {
      page.setConsent(state);
      expect(page.off(), JSON.stringify(state)).toBe(off);
    }
    // Nothing was dispatched, so the page itself did nothing: only the switch moved.
    expect(page.dataLayer()!.length).toBe(layer);
    expect(page.appended).toHaveLength(1);
  });

  it('a no given in another window before load means gtag.js is never asked for', () => {
    const page = load({ loading: true, cookies: { [CONSENT_COOKIE]: consentValue(choice(true)) } });
    page.setConsent(choice(false));
    page.loaded();
    expect(page.appended).toEqual([]);
  });

  it('a choice changed in another tab stops the next hit at once, and is followed in full when this tab is shown again', () => {
    const page = load({ cookies: { [CONSENT_COOKIE]: consentValue(choice(true)) } });
    for (const [name, value] of Object.entries(GA_COOKIES)) page.jar.set(name, value);
    const layer = page.dataLayer()!.length;
    page.show(false);
    // The other tab says no: nothing fires here, but Google's off switch already reads it.
    page.setConsent(choice(false));
    expect(page.off()).toBe(true);
    // Consent mode and the cookies wait until this tab is looked at again.
    page.show(false);
    expect(page.dataLayer()!.length).toBe(layer);
    expect(page.jar.has('_ga')).toBe(true);
    page.show(true);
    expect(page.off()).toBe(true);
    expect(page.dataLayer()!.at(-1)).toEqual([
      'consent',
      'update',
      {
        analytics_storage: 'denied',
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
      },
    ]);
    expect([...page.jar.keys()]).toEqual([CONSENT_COOKIE]);
    // And a yes given there resumes here when this page hears of it, with no second request
    // (until then the switch stays off: this page's consent mode still says denied).
    page.setConsent(choice(true));
    expect(page.off()).toBe(true);
    page.show(true);
    expect(page.off()).toBe(false);
    expect(page.appended).toHaveLength(1);
  });

  it('a page restored from the back-forward cache follows a choice changed elsewhere', () => {
    const page = load({ cookies: { [CONSENT_COOKIE]: consentValue(choice(true)) } });
    for (const [name, value] of Object.entries(GA_COOKIES)) page.jar.set(name, value);
    const layer = page.dataLayer()!.length;
    page.setConsent(null);
    expect(page.off()).toBe(true);
    page.dispatchWindow('pageshow', { persisted: false });
    expect(page.dataLayer()!.length).toBe(layer);
    expect(page.jar.has('_ga')).toBe(true);
    page.dispatchWindow('pageshow', { persisted: true });
    expect(page.dataLayer()!.at(-1)).toEqual([
      'consent',
      'update',
      {
        analytics_storage: 'denied',
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
      },
    ]);
    expect(page.jar.has('_ga')).toBe(false);
  });
});

describe('the Report-Only cycle: a refused Google address is reported, never its query', () => {
  const violation = (blockedURI: string, effectiveDirective = 'connect-src') => ({
    blockedURI,
    effectiveDirective,
  });

  it('reports the directive and a Google address without its query, once each, at most five', () => {
    const page = load({ cookies: { [CONSENT_COOKIE]: consentValue(choice(true)) } });
    page.dispatch(
      'securitypolicyviolation',
      violation('https://region9.google-analytics.com/g/collect?cid=123.456&tid=G-TEST1234'),
    );
    page.dispatch(
      'securitypolicyviolation',
      violation('https://region9.google-analytics.com/g/collect?cid=999'),
    );
    page.dispatch('securitypolicyviolation', violation('https://example.com/x'));
    page.dispatch('securitypolicyviolation', violation('inline', 'script-src-elem'));
    expect(page.beacons).toEqual([
      {
        url: '/api/clientlog',
        body: {
          level: 'warn',
          message:
            'GA4: the CSP refused connect-src https://region9.google-analytics.com/g/collect (not listed)',
          source: 'ga4-csp',
          path: '/services/logo',
        },
      },
    ]);
    expect(JSON.stringify(page.beacons)).not.toContain('cid');
    for (const host of [
      'a.google.com',
      'b.doubleclick.net',
      'www.google.co.uk',
      'c.google.sa',
      'd.googletagmanager.com',
      'e.googlesyndication.com',
    ]) {
      page.dispatch('securitypolicyviolation', violation(`https://${host}/p?x=1`, 'img-src'));
    }
    expect(page.beacons).toHaveLength(5);
  });

  it('names the path a listed host was refused on (script-src lists one path of it)', () => {
    const page = load({ cookies: { [CONSENT_COOKIE]: consentValue(choice(true)) } });
    page.dispatch(
      'securitypolicyviolation',
      violation('https://www.googletagmanager.com/gtm.js?id=GTM-ABC1234#x', 'script-src-elem'),
    );
    expect(page.beacons.map((b) => (b.body as { message: string }).message)).toEqual([
      'GA4: the CSP refused script-src-elem https://www.googletagmanager.com/gtm.js (not listed)',
    ]);
  });

  it('listens only once Google has been asked for (after consent)', () => {
    const page = load();
    page.dispatch(
      'securitypolicyviolation',
      violation('https://www.google-analytics.com/g/collect'),
    );
    expect(page.beacons).toEqual([]);
  });
});
