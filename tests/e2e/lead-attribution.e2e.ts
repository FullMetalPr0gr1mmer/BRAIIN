import { expect, test, type Page } from '@playwright/test';
import { CONSENT_VERSION } from '../../packages/consent/gate';
import { consentCookieHeader } from './consentCookie';

/*
 * Lead attribution, the browser's half (Admin v2 C13: src/lib/client/attribution.ts, wired by
 * src/lib/client/analytics.ts and read by ContactForm's send), in a real browser against the
 * built Worker, in English and Arabic:
 *   - before the visitor chooses, and after "Reject", nothing is written to sessionStorage
 *     (`bs_ft`) and a sent inquiry carries no `attribution`;
 *   - after "Accept analytics" the page's campaign tags are kept, once: a later page with other
 *     tags does not replace them, and the inquiry sent from it carries them;
 *   - the stored first touch is never the page's URL or query, only the three tags;
 *   - a yes withdrawn mid-visit removes it, and so does a yes given to an older notice (the
 *     banner asks again, and the inquiry carries nothing): C13 review COR-7 and COR-1.
 * /api/contact is answered by the test (route.fulfill), so nothing is stored anywhere; the
 * server's half (hasConsent, the landing path, the cleaners) is tests/api/contactAttribution.spec.ts.
 */

const PAGES = {
  en: { contact: '/contact', about: '/about' },
  ar: { contact: '/ar/contact', about: '/ar/about' },
};

const TAGS = 'utm_source=newsletter&utm_medium=email&utm_campaign=spring';
const LATER = 'utm_source=other&utm_medium=cpc&utm_campaign=later';

const stored = (page: Page) => page.evaluate(() => sessionStorage.getItem('bs_ft'));

/** Answers /api/contact itself and keeps each body the form sent. */
async function captureSends(page: Page): Promise<Record<string, unknown>[]> {
  const bodies: Record<string, unknown>[] = [];
  await page.route('**/api/contact', async (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  return bodies;
}

/** Writes the consent cookie as the banner does, and tells the page, as the banner does. */
async function setChoice(page: Page, cookie: string, announce = true) {
  await page.evaluate(
    ({ cookie, announce }) => {
      document.cookie = `${cookie}; Path=/; Secure; SameSite=Lax`;
      if (announce) document.dispatchEvent(new CustomEvent('consent-updated'));
    },
    { cookie, announce },
  );
}

async function sendInquiry(page: Page) {
  await page.locator('#cf-name').fill('Test Visitor');
  await page.locator('#cf-email').fill('visitor@example.test');
  await page.locator('#cf-message').fill('A launch film.');
  await page.locator('#contact-form button[type="submit"]').click();
  await expect(page.locator('#cf-name')).toBeHidden();
}

for (const locale of ['en', 'ar'] as const) {
  const p = PAGES[locale];

  test.describe(`lead attribution — ${locale}`, () => {
    test('nothing is kept or sent before a choice, nor after Reject', async ({ page }) => {
      const sent = await captureSends(page);
      await page.goto(`${p.contact}?${TAGS}`, { waitUntil: 'load' });
      await expect(page.locator('#consent-banner')).toBeVisible();
      expect(await stored(page)).toBeNull();

      await sendInquiry(page);
      expect(sent).toHaveLength(1);
      expect(sent[0]).not.toHaveProperty('attribution');

      await page.goto(`${p.contact}?${TAGS}`, { waitUntil: 'load' });
      await page.locator('[data-consent="reject"]').click();
      await expect(page.locator('#consent-banner')).toBeHidden();
      expect(await stored(page)).toBeNull();
      await sendInquiry(page);
      expect(sent).toHaveLength(2);
      expect(sent[1]).not.toHaveProperty('attribution');
    });

    test('after Accept the first page’s tags are kept once and ride the inquiry', async ({
      page,
    }) => {
      const sent = await captureSends(page);
      await page.goto(`${p.about}?${TAGS}`, { waitUntil: 'load' });
      expect(await stored(page)).toBeNull();
      await page.locator('[data-consent="accept"]').click();
      await expect(page.locator('#consent-banner')).toBeHidden();

      // Present first, then its shape (a missing value must fail, never match nothing).
      const first = await stored(page);
      expect(first).not.toBeNull();
      expect(JSON.parse(first!)).toEqual({
        utmSource: 'newsletter',
        utmMedium: 'email',
        utmCampaign: 'spring',
      });
      expect(first).not.toContain('/about');

      // A later page with other tags does not replace the first touch.
      await page.goto(`${p.contact}?${LATER}`, { waitUntil: 'load' });
      expect(await stored(page)).toBe(first);

      await sendInquiry(page);
      expect(sent).toHaveLength(1);
      expect(sent[0]!['attribution']).toEqual({
        utmSource: 'newsletter',
        utmMedium: 'email',
        utmCampaign: 'spring',
      });
    });

    test('a withdrawn yes, or a yes to an older notice, removes the first touch', async ({
      page,
    }) => {
      const sent = await captureSends(page);
      await page.goto(`${p.contact}?${TAGS}`, { waitUntil: 'load' });
      await page.locator('[data-consent="accept"]').click();
      await expect(page.locator('#consent-banner')).toBeHidden();
      expect(await stored(page)).not.toBeNull();

      // Withdrawn mid-visit: the cookie says no and the page hears consent-updated.
      await setChoice(page, consentCookieHeader({ analytics: false }));
      expect(await stored(page)).toBeNull();

      // A yes again keeps this page's tags again.
      await setChoice(page, consentCookieHeader({ analytics: true }));
      expect(await stored(page)).not.toBeNull();

      // The notice changed under that yes (a choice under an older version): on the next page
      // the banner asks again, the first touch is gone, and the inquiry carries none.
      await setChoice(page, consentCookieHeader({ analytics: true }, CONSENT_VERSION - 1), false);
      await page.goto(p.contact, { waitUntil: 'load' });
      await expect(page.locator('#consent-banner')).toBeVisible();
      expect(await stored(page)).toBeNull();
      await sendInquiry(page);
      expect(sent).toHaveLength(1);
      expect(sent[0]).not.toHaveProperty('attribution');
    });
  });
}
