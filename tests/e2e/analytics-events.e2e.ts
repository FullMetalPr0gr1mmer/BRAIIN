import { expect, test, type Page, type Request } from '@playwright/test';

/*
 * The public site's first-party analytics events (Admin v2 G1: src/lib/client/analytics.ts),
 * in a real browser against the built Worker, in English and Arabic:
 *   - nothing reaches /api/analytics before the visitor accepts analytics cookies, clicks on
 *     tracked links included;
 *   - after accepting, a click on the WhatsApp card sends exactly one `cta_click`
 *     ({ cta: 'whatsapp' }), however many times it is clicked in one page view;
 *   - the /services explorer sends one `service_interest` for a discipline the visitor opens,
 *     and none for the panel a URL's hash opened at load;
 *   - the language link's beacon survives the navigation it starts (sendBeacon).
 * The links that leave the site (wa.me, mailto:) are kept from leaving: a capture listener
 * added before the page's own scripts prevents their default action, which stops nothing the
 * emitter hears (it listens on the document, in the bubble phase).
 */

const PAGES = {
  en: { contact: '/contact', services: '/services' },
  ar: { contact: '/ar/contact', services: '/ar/services' },
};

interface Beacon {
  type: string;
  path?: string;
  locale?: string;
  sessionId?: string;
  props?: Record<string, string>;
}

/** Records every beacon to /api/analytics, its body parsed. */
function beacons(page: Page): Beacon[] {
  const seen: Beacon[] = [];
  page.on('request', (req: Request) => {
    if (new URL(req.url()).pathname !== '/api/analytics') return;
    try {
      seen.push(req.postDataJSON() as Beacon);
    } catch {
      seen.push({ type: 'unreadable' });
    }
  });
  return seen;
}

async function keepOnSite(page: Page) {
  await page.addInitScript(() => {
    document.addEventListener(
      'click',
      (e) => {
        const a = e.target instanceof Element ? e.target.closest('a') : null;
        if (a && /^(mailto:|https:\/\/wa\.me\/|https:\/\/api\.whatsapp\.com\/)/.test(a.href)) {
          e.preventDefault();
        }
      },
      true,
    );
  });
}

async function accept(page: Page) {
  await page.locator('[data-consent="accept"]').click();
  await expect(page.locator('#consent-banner')).toBeHidden();
}

const settle = (page: Page) => page.waitForTimeout(400);

for (const locale of ['en', 'ar'] as const) {
  const p = PAGES[locale];

  test.describe(`analytics events — ${locale}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 1366, height: 900 });
      await keepOnSite(page);
    });

    test('nothing is sent before consent, clicks included', async ({ page }) => {
      const sent = beacons(page);
      await page.goto(p.contact, { waitUntil: 'networkidle' });
      const whatsapp = page.locator('a[data-track="whatsapp"]');
      if ((await whatsapp.count()) > 0) await whatsapp.first().click();
      await page.locator('a[data-track="email"]').first().click();
      await settle(page);
      expect(sent).toEqual([]);
    });

    test('after accepting: the page view, then one cta_click per link per page view', async ({
      page,
    }) => {
      const sent = beacons(page);
      await page.goto(p.contact, { waitUntil: 'networkidle' });
      await accept(page);
      await expect.poll(() => sent.filter((b) => b.type === 'pageview').length).toBe(1);
      const view = sent.find((b) => b.type === 'pageview')!;
      expect(view.locale).toBe(locale);
      expect(view.path).toBe(p.contact);

      const email = page.locator('a[data-track="email"]').first();
      await email.click();
      await email.click();
      const whatsapp = page.locator('a[data-track="whatsapp"]');
      const hasWhatsapp = (await whatsapp.count()) > 0;
      if (hasWhatsapp) {
        await whatsapp.first().click();
        await whatsapp.first().click();
      }
      await settle(page);
      const clicks = sent.filter((b) => b.type === 'cta_click');
      expect(clicks.map((b) => b.props)).toEqual([
        { cta: 'email' },
        ...(hasWhatsapp ? [{ cta: 'whatsapp' }] : []),
      ]);
      // The same per-tab id as the page view, and no other key.
      for (const click of clicks) {
        expect(click.sessionId).toBe(view.sessionId);
        expect(Object.keys(click).sort()).toEqual(['locale', 'path', 'props', 'sessionId', 'type']);
      }
    });

    test('the explorer: one service_interest for a panel the visitor opens, none from the hash', async ({
      page,
    }) => {
      // Opened by the URL at load: not the visitor's choice, nothing but the page view.
      const first = beacons(page);
      await page.goto(`${p.services}#branding`, { waitUntil: 'networkidle' });
      await accept(page);
      await expect(page.locator('.svc-panel#branding')).toBeVisible();
      await settle(page);
      expect(first.filter((b) => b.type === 'service_interest')).toEqual([]);

      // A fresh page view: the visitor opens a discipline (twice: one beacon).
      const sent = beacons(page);
      await page.goto(p.services, { waitUntil: 'networkidle' });
      await page.locator('.disc-card[data-disc="production"]').click();
      await expect(page.locator('.svc-panel#production')).toBeVisible();
      await page.locator('.disc-card[data-disc="production"]').click();
      await settle(page);
      expect(sent.filter((b) => b.type === 'service_interest').map((b) => b.props)).toEqual([
        { discipline: 'production' },
      ]);
      // The card is a tracked link too.
      expect(sent.filter((b) => b.type === 'cta_click').map((b) => b.props)).toEqual([
        { cta: 'discipline_card' },
      ]);
    });

    test('the language link’s beacon survives the navigation it starts', async ({ page }) => {
      await page.goto(p.contact, { waitUntil: 'networkidle' });
      await accept(page);
      const id = locale === 'en' ? 'language_ar' : 'language_en';
      const beacon = page.waitForRequest(
        (req) =>
          new URL(req.url()).pathname === '/api/analytics' &&
          (req.postDataJSON() as Beacon | null)?.props?.['cta'] === id,
      );
      await page.locator(`a.site-header__lang[data-track="${id}"]`).click();
      expect((await beacon).postDataJSON()).toMatchObject({ type: 'cta_click', locale });
      await page.waitForURL(locale === 'en' ? /\/ar\/contact/ : /\/contact$/);
    });
  });
}

test('the ingest refuses an event outside the vocabulary (422) and drops one without consent (204)', async ({
  request,
}) => {
  const origin = new URL(test.info().project.use.baseURL ?? 'http://localhost:8788').origin;
  const headers = { origin, 'content-type': 'application/json' };
  // No consent cookie: dropped before the body is even judged.
  const dropped = await request.post('/api/analytics', {
    headers,
    data: { type: 'cta_click', path: '/', locale: 'en', props: { cta: 'whatsapp' } },
  });
  expect(dropped.status()).toBe(204);
  const consent = `__Host-consent=${encodeURIComponent(JSON.stringify({ analytics: true }))}`;
  const refused = await request.post('/api/analytics', {
    headers: { ...headers, cookie: consent },
    data: { type: 'cta_click', path: '/', locale: 'en', props: { cta: 'made_up' } },
  });
  expect(refused.status()).toBe(422);
});
