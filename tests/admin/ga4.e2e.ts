import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { CONSENT_VERSION } from '../../packages/consent/gate';
import { consentCookieHeader } from '../e2e/consentCookie';
import { SKIP_REASON, authFile, staffEnv } from './staff';

/*
 * Google Analytics 4 behind analytics consent (Admin v2 U15), through the real Worker, in
 * English and Arabic, with the switch on (the CI e2e build sets GA4_NOTICE_READY, which no
 * production build carries until the notice sign-off) and an id saved by an Admin:
 *   - the page carries the same-origin loader and its CSP lists Google's hosts;
 *   - before consent, not one request reaches any Google host;
 *   - the banner's yes makes the loader request gtag.js, which is ROUTE-INTERCEPTED: a fake
 *     served from the intercepted host stands in, and every other Google host answers 204,
 *     so the real Google is never reached; the fake's own hits (a collect fetch and an image)
 *     pass the CSP;
 *   - withdrawal (what the banner's no does: the cookie rewritten, `consent-updated`) denies
 *     consent mode, sets Google's off switch and clears the _ga cookies; the next page asks
 *     Google for nothing;
 *   - zero CSP violations on every page, and search never carries the loader.
 *
 * Its own project (playwright.config.ts `ga4`), alone, after `general` and before
 * `maintenance`: a saved id puts the loader on every public page the other specs read. The id
 * is cleared afterwards whatever happened.
 */

test.skip(!staffEnv(), SKIP_REASON);
test.skip(
  process.env['GA4_NOTICE_READY'] !== 'true' && !process.env['CI'],
  'the preview was built with GA4_NOTICE_READY off (the CI e2e build turns it on)',
);
test.describe.configure({ mode: 'serial' });

const ID = 'G-U15E2E01';
const LOADER = `<script src="/scripts/ga4.js" data-ga4-id="${ID}" data-consent-version="${CONSENT_VERSION}" defer></script>`;
/** Every Google host gtag.js could ask for: intercepted, never reached. */
const GOOGLE =
  /^https?:\/\/(?:[a-z0-9-]+\.)*(?:googletagmanager\.com|google-analytics\.com|google\.com|google\.[a-z]{2,3}(?:\.[a-z]{2})?|doubleclick\.net|googlesyndication\.com|gstatic\.com)(?::\d+)?\//i;

/** The stand-in for gtag.js: what it was handed, the cookies it would set, two hits. */
const FAKE_GTAG = `(() => {
  const id = new URL(document.currentScript.src).searchParams.get('id');
  window.__fakeGtag = { id, queued: (window.dataLayer || []).length };
  document.cookie = '_ga=GA1.1.1234.5678; Path=/; Max-Age=600; SameSite=Lax';
  document.cookie = '_ga_' + id.slice(2) + '=GS1.1.1.1; Path=/; Max-Age=600; SameSite=Lax';
  fetch('https://region1.google-analytics.com/g/collect?v=2&tid=' + id + '&en=page_view', {
    method: 'POST', mode: 'no-cors', keepalive: true,
  });
  new Image().src = 'https://www.google-analytics.com/g/collect?v=2&tid=' + id;
})();`;

const PAGES = {
  en: { first: '/contact', next: '/about', search: '/search' },
  ar: { first: '/ar/contact', next: '/ar/about', search: '/ar/search' },
} as const;

async function adminPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ storageState: authFile('admin') });
  const page = await context.newPage();
  await page.goto('/admin', { waitUntil: 'networkidle' });
  return { context, page };
}

/** Saves the GA4 id (or clears it) as Admin, through the route (immediate: no release). */
async function saveId(browser: Browser, id: string | null) {
  const { context, page } = await adminPage(browser);
  try {
    const token = await page.locator('meta[name="csrf-token"]').getAttribute('content');
    expect(token, 'the admin layout carries a CSRF token').toBeTruthy();
    const got = await page.request.get('/api/admin/integrations');
    expect(got.status(), await got.text()).toBe(200);
    const row = ((await got.json()) as { data: Record<string, unknown> }).data;
    if (row['ga4_measurement_id'] === id) return;
    const res = await page.request.patch('/api/admin/integrations', {
      headers: { 'x-csrf-token': token!, origin: new URL(page.url()).origin },
      data: { ga4MeasurementId: id, version: Number(row['version'] ?? 0) },
    });
    expect(res.status(), await res.text()).toBe(200);
  } finally {
    await context.close();
  }
}

/** A visitor's browser with every Google host intercepted and every request to one recorded. */
async function visitor(browser: Browser) {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const google: string[] = [];
  context.on('request', (req) => {
    if (GOOGLE.test(req.url())) google.push(req.url());
  });
  await context.route(GOOGLE, (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'www.googletagmanager.com' && url.pathname === '/gtag/js') {
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_GTAG });
    }
    return route.fulfill({ status: 204, body: '' });
  });
  await context.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = seen;
    document.addEventListener('securitypolicyviolation', (e) => {
      seen.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  const page = await context.newPage();
  // The width the other consent specs click the banner at (tests/e2e/analytics-events.e2e.ts).
  await page.setViewportSize({ width: 1366, height: 900 });
  return { context, page, google };
}

const violations = (page: Page) =>
  page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
const dataLayer = (page: Page) =>
  page.evaluate(() => {
    const layer = (window as unknown as { dataLayer?: ArrayLike<unknown>[] }).dataLayer;
    return layer === undefined
      ? null
      : JSON.parse(JSON.stringify(Array.from(layer, (e) => Array.from(e))));
  }) as Promise<unknown[][] | null>;
const gaCookies = async (context: BrowserContext) =>
  (await context.cookies()).filter((c) => /^_ga(?:_|$)/.test(c.name)).map((c) => c.name);

/** Writes a choice as the banner does (the same cookie attributes), optionally announcing it. */
async function choose(page: Page, analytics: boolean, announce: boolean) {
  await page.evaluate(
    ([cookie, tell]) => {
      document.cookie = `${cookie}; Path=/; Secure; SameSite=Lax; Max-Age=15552000`;
      if (!tell) return;
      const state = JSON.parse(decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)));
      document.dispatchEvent(new CustomEvent('consent-updated', { detail: state }));
    },
    [consentCookieHeader({ analytics }), announce] as const,
  );
}

/**
 * What the banner's "Reject non-essential" does once a choice exists: the cookie rewritten,
 * then `consent-updated`. (The site has no control that reopens the banner yet: a switch-on
 * prerequisite, launch runbook §2e.)
 */
const withdraw = (page: Page) => choose(page, false, true);

test.beforeAll(async ({ browser }) => {
  if (process.env['CI']) {
    expect(process.env['GA4_NOTICE_READY'], 'the CI e2e build turns GA4 on').toBe('true');
  }
  await saveId(browser, ID);
});

test.afterAll(async ({ browser }) => {
  await saveId(browser, null);
});

for (const [locale, paths] of Object.entries(PAGES)) {
  test(`${locale}: nothing from Google before consent, gtag after, withdrawal stops it`, async ({
    browser,
  }) => {
    const { context, page, google } = await visitor(browser);
    try {
      // The page carries the loader, and only then lists Google's hosts.
      const res = await page.goto(paths.first, { waitUntil: 'networkidle' });
      expect(res?.status()).toBe(200);
      const html = await res!.text();
      expect(html.split(LOADER), 'exactly one loader tag').toHaveLength(2);
      const policy = res!.headers()['content-security-policy'] ?? '';
      expect(policy).toMatch(/script-src [^;]*https:\/\/www\.googletagmanager\.com/);
      expect(policy).toMatch(/connect-src [^;]*https:\/\/\*\.google-analytics\.com/);
      expect(policy).not.toContain("'unsafe-inline'");

      // Before consent: not one request to any Google host, and no dataLayer.
      await page.waitForTimeout(500);
      expect(google, 'requests to Google before consent').toEqual([]);
      expect(await dataLayer(page)).toBeNull();

      // The banner's yes: gtag.js is requested (intercepted), and its hits pass the CSP.
      await page.locator('[data-consent="accept"]').click();
      await expect(page.locator('#consent-banner')).toBeHidden();
      await expect
        .poll(() => google.filter((u) => u.startsWith('https://www.googletagmanager.com/gtag/js')))
        .toEqual([`https://www.googletagmanager.com/gtag/js?id=${ID}`]);
      await expect
        .poll(() =>
          google.some((u) => u.startsWith('https://region1.google-analytics.com/g/collect')),
        )
        .toBe(true);
      await expect
        .poll(() => google.some((u) => u.startsWith('https://www.google-analytics.com/g/collect')))
        .toBe(true);
      await expect
        .poll(() => page.evaluate(() => 'gtag' in window && '__fakeGtag' in window))
        .toBe(true);
      const layer = (await dataLayer(page))!;
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
      expect(layer[3]?.[0]).toBe('config');
      expect(layer[3]?.[2]).toMatchObject({
        allow_google_signals: false,
        allow_ad_personalization_signals: false,
        page_location: new URL(paths.first, page.url()).href,
      });
      expect(await gaCookies(context)).toEqual(
        expect.arrayContaining(['_ga', `_ga_${ID.slice(2)}`]),
      );

      // Withdrawal: consent mode denied, Google's off switch, the cookies cleared.
      await withdraw(page);
      const off = await page.evaluate(
        (id) => (window as unknown as Record<string, unknown>)[`ga-disable-${id}`],
        ID,
      );
      expect(off, "Google's own off switch").toBe(true);
      expect((await dataLayer(page))!.at(-1)).toEqual([
        'consent',
        'update',
        {
          analytics_storage: 'denied',
          ad_storage: 'denied',
          ad_user_data: 'denied',
          ad_personalization: 'denied',
        },
      ]);
      await expect.poll(() => gaCookies(context)).toEqual([]);
      expect(await violations(page), `CSP violations on ${paths.first}`).toEqual([]);

      // The next page asks Google for nothing: the choice is a no.
      const before = google.length;
      const next = await page.goto(paths.next, { waitUntil: 'networkidle' });
      expect(next?.status()).toBe(200);
      expect((await next!.text()).split(LOADER)).toHaveLength(2);
      await page.waitForTimeout(500);
      expect(google.slice(before), `requests to Google on ${paths.next} after withdrawal`).toEqual(
        [],
      );
      expect(await dataLayer(page)).toBeNull();
      expect(await violations(page), `CSP violations on ${paths.next}`).toEqual([]);

      // Search never carries the loader, nor lists Google, whatever was chosen.
      const search = await page.request.get(paths.search);
      expect(await search.text()).not.toContain('/scripts/ga4.js');
      expect(search.headers()['content-security-policy'] ?? '').not.toMatch(/google/);
    } finally {
      await context.close();
    }
  });
}

test('a visitor who already said yes loads gtag at once, and only gtag from Google first', async ({
  browser,
}) => {
  const { context, page, google } = await visitor(browser);
  try {
    // The yes is written from search, which never carries the loader, so nothing from Google
    // can have loaded before it; then a page that does carry it.
    const search = await page.goto(PAGES.en.search, { waitUntil: 'networkidle' });
    expect(await search!.text()).not.toContain('/scripts/ga4.js');
    await choose(page, true, false);
    expect(google, 'nothing from Google on search').toEqual([]);
    const res = await page.goto(PAGES.en.next, { waitUntil: 'networkidle' });
    expect((await res!.text()).split(LOADER)).toHaveLength(2);
    await expect.poll(() => google[0]).toBe(`https://www.googletagmanager.com/gtag/js?id=${ID}`);
    await expect(page.locator('#consent-banner')).toBeHidden();
    expect(await violations(page)).toEqual([]);
  } finally {
    await context.close();
  }
});
