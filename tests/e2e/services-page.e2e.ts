import { expect, test, type Page } from '@playwright/test';

/*
 * /services and /ar/services (Round 2, S3), against the seeded local database: five
 * published disciplines holding 28 services, each with a poster and a clip window.
 *
 * The mockup built the whole explorer with script (innerHTML per click). The port
 * server-renders every panel, so these assertions check both halves of the contract: the
 * HTML without JS (all 28 service links, the `:target` deep link) and the enhancement
 * (APG tabs, the instant open, focus, the hash, the row-hover media swap, the preselect).
 */

const PAGES = {
  en: {
    path: '/services',
    prefix: '',
    next: 'ArrowRight',
    prev: 'ArrowLeft',
    start: 'Start your Branding project',
  },
  ar: {
    path: '/ar/services',
    prefix: '/ar',
    next: 'ArrowLeft',
    prev: 'ArrowRight',
    start: 'ابدأ مشروع الهوية البصرية',
  },
} as const;

const SLUGS = ['branding', 'production', 'marketing', 'web', 'events'];
const SERVICE_COUNT = 28;

/** The consent banner is fixed at the bottom and can sit over a row; these tests are not about it. */
async function hideConsent(page: Page): Promise<void> {
  await page.evaluate(() => document.getElementById('consent-banner')?.remove());
}

/** Parks the card stage mid-screen, where the scroll-driven rise has finished. */
async function parkCards(page: Page): Promise<void> {
  await page.locator('#categories .disc__stage').scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const r = document.querySelector('#categories .disc__stage')!.getBoundingClientRect();
    window.scrollBy(0, r.top - (innerHeight - r.height) / 2);
  });
  await page.waitForTimeout(700);
}

const activePanels = (page: Page) => page.locator('.svc-panel:visible');

for (const locale of ['en', 'ar'] as const) {
  const p = PAGES[locale];

  test.describe(`services page — ${locale}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 1366, height: 900 });
    });

    test('five discipline cards, each a link into its explorer panel', async ({ page }) => {
      await page.goto(p.path, { waitUntil: 'load' });
      const cards = page.locator('#categories .disc__stage > .disc-card');
      await expect(cards).toHaveCount(5);
      for (const [i, slug] of SLUGS.entries()) {
        await expect(cards.nth(i)).toHaveAttribute('href', `#${slug}`);
        await expect(page.locator(`.svc-panel#${slug}`)).toHaveCount(1);
      }
      // Collapsed until something opens it.
      await expect(page.locator('.svc-xp')).toBeHidden();
    });

    test('a card click opens its panel at once, moves focus to it and updates the hash', async ({
      page,
    }) => {
      await page.goto(p.path, { waitUntil: 'load' });
      await hideConsent(page);
      await parkCards(page);
      await page.locator('.disc-card[data-disc="production"]').click();
      const panel = page.locator('.svc-panel#production');
      await expect(panel).toBeVisible();
      await expect(activePanels(page)).toHaveCount(1);
      await expect(panel).toBeFocused();
      await expect(panel).toHaveAttribute('role', 'tabpanel');
      expect(new URL(page.url()).hash).toBe('#production');
      await expect(page.locator('#svc-tab-production')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('.disc-card[data-disc="production"]')).toHaveClass(/\bon\b/);
      await expect(page.locator('.disc-card.on')).toHaveCount(1);
    });

    test('keyboard: Enter on a card opens and focuses its panel', async ({ page }) => {
      await page.goto(p.path, { waitUntil: 'load' });
      await page.locator('.disc-card[data-disc="web"]').focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('.svc-panel#web')).toBeFocused();
    });

    test('the tabs work by keyboard: arrows (mirrored in RTL), Home/End, wrap-around', async ({
      page,
    }) => {
      await page.goto(`${p.path}#branding`, { waitUntil: 'load' });
      const tablist = page.locator('.svc-xp__tabs');
      await expect(tablist).toHaveAttribute('role', 'tablist');
      const tabs = tablist.locator('[role="tab"]');
      await expect(tabs).toHaveCount(5);
      // Roving tabindex: only the selected tab is in the Tab sequence.
      await expect(tablist.locator('[tabindex="0"]')).toHaveCount(1);
      const selected = page.locator('#svc-tab-branding');
      await expect(selected).toHaveAttribute('aria-selected', 'true');
      await expect(selected).toHaveAttribute('aria-controls', 'branding');
      await expect(page.locator('#branding')).toHaveAttribute(
        'aria-labelledby',
        'svc-tab-branding',
      );

      await selected.focus();
      await page.keyboard.press(p.next);
      await expect(page.locator('#svc-tab-production')).toBeFocused();
      await expect(page.locator('#svc-tab-production')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('.svc-panel#production')).toBeVisible();
      await expect(page.locator('.svc-panel#branding')).toBeHidden();

      await page.keyboard.press('End');
      await expect(page.locator('#svc-tab-events')).toBeFocused();
      await expect(page.locator('.svc-panel#events')).toBeVisible();

      await page.keyboard.press(p.next); // wraps to the first
      await expect(page.locator('#svc-tab-branding')).toBeFocused();
      await expect(page.locator('.svc-panel#branding')).toBeVisible();

      await page.keyboard.press(p.prev); // and back round to the last
      await expect(page.locator('#svc-tab-events')).toBeFocused();

      await page.keyboard.press('Home');
      await expect(page.locator('#svc-tab-branding')).toBeFocused();
      await expect(page.locator('#svc-tab-branding')).toHaveAttribute('tabindex', '0');
      expect(new URL(page.url()).hash).toBe('#branding');
    });

    test('/services#events opens Events on load', async ({ page }) => {
      await page.goto(`${p.path}#events`, { waitUntil: 'load' });
      await expect(page.locator('.svc-xp')).toBeVisible();
      await expect(page.locator('.svc-panel#events')).toBeVisible();
      await expect(activePanels(page)).toHaveCount(1);
      await expect(page.locator('#svc-tab-events')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('.disc-card[data-disc="events"]')).toHaveClass(/\bon\b/);
    });

    test('prev / next wrap and keep focus in the explorer', async ({ page }) => {
      await page.goto(`${p.path}#branding`, { waitUntil: 'load' });
      await hideConsent(page);
      await page.locator('.svc-panel#branding .svc-xp__btn--prev').click();
      await expect(page.locator('.svc-panel#events')).toBeVisible();
      await expect(page.locator('.svc-panel#events')).toBeFocused();
      await page.locator('.svc-panel#events .svc-xp__btn--next').click();
      await expect(page.locator('.svc-panel#branding')).toBeVisible();
    });

    test('hovering a service row swaps the panel media, and leaving restores it', async ({
      page,
    }) => {
      await page.goto(`${p.path}#branding`, { waitUntil: 'load' });
      await hideConsent(page);
      const panel = page.locator('.svc-panel#branding');
      const frame = panel.locator('.svc-xp__mf');
      const caption = panel.locator('[data-xp-cap]');
      const discipline = (await caption.textContent())?.trim();
      const row = panel.locator('.svc-row').nth(1);
      await row.scrollIntoViewIfNeeded();
      const poster = await row.getAttribute('data-xp-poster');
      expect(poster, 'the row carries a server-computed poster URL').toBeTruthy();
      const name = (await row.locator('.svc-row__t').textContent())?.trim();

      await row.locator('.svc-row__t').hover();
      await expect(caption).toHaveText(name!);
      await expect(frame).toHaveClass(/\bis-swapped\b/);
      await expect(frame.locator('img.svc-xp__swap')).toHaveAttribute('src', poster!);
      // The swap is attributes and CSSOM only (CSP: no inline style in served HTML either).
      expect(await frame.locator('img.svc-xp__swap').getAttribute('style')).toBeNull();

      await page.mouse.move(2, 2);
      await expect(caption).toHaveText(discipline!);
      await expect(frame).not.toHaveClass(/\bis-swapped\b/);
    });

    test('"Start your Branding project" preselects the discipline in the form', async ({
      page,
    }) => {
      await page.goto(`${p.path}#branding`, { waitUntil: 'load' });
      await hideConsent(page);
      const start = page.locator('.svc-panel#branding .svc-xp__start');
      await expect(start).toHaveText(p.start);
      await expect(start).toHaveAttribute('href', '#inquiry');
      await expect(start).toHaveAttribute('data-preselect', 'discipline:branding');
      await start.click();
      await expect(page.locator('#cf-service')).toHaveValue('discipline:branding');
      expect(new URL(page.url()).hash).toBe('#inquiry');
    });

    test('every Inquire pill goes to its service page form, named for its service', async ({
      page,
    }) => {
      await page.goto(p.path, { waitUntil: 'load' });
      const rows = page.locator('.svc-row');
      await expect(rows).toHaveCount(SERVICE_COUNT);
      for (let i = 0; i < SERVICE_COUNT; i++) {
        const row = rows.nth(i);
        const href = await row.locator('.svc-row__a').getAttribute('href');
        expect(href).toMatch(new RegExp(`^${p.prefix}/services/[a-z0-9-]+$`));
        await expect(row.locator('.svc-row__q')).toHaveAttribute('href', `${href}#inquiry`);
        const name = (await row.locator('.svc-row__t').textContent())?.trim();
        const label = await row.locator('.svc-row__q').getAttribute('aria-label');
        expect(label?.endsWith(`: ${name}`), `${label} names ${name}`).toBe(true);
      }
    });

    test('without JS: all 28 service links are in the page, and #events opens by :target', async ({
      browser,
    }) => {
      const ctx = await browser.newContext({ javaScriptEnabled: false });
      const page = await ctx.newPage();
      await page.setViewportSize({ width: 1366, height: 900 });
      await page.goto(p.path);
      await expect(page.locator(`a.svc-row__a[href^="${p.prefix}/services/"]`)).toHaveCount(
        SERVICE_COUNT,
      );
      // No script, no ARIA widget promises: the tabs are plain links.
      await expect(page.locator('[role="tab"]')).toHaveCount(0);
      await expect(page.locator('.svc-xp')).toBeHidden();

      await page.goto(`${p.path}#events`);
      await expect(page.locator('.svc-panel#events')).toBeVisible();
      await expect(activePanels(page)).toHaveCount(1);
      // A card is a plain fragment link: following it opens that panel.
      await page.locator('.disc-card[data-disc="web"]').focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('.svc-panel#web')).toBeVisible();
      await expect(activePanels(page)).toHaveCount(1);
      await ctx.close();
    });
  });
}

test('the page opens on the banner hero under the overlay header, its CTA to the cards', async ({
  page,
}) => {
  await page.goto('/services', { waitUntil: 'load' });
  await expect(page.locator('.site-header')).toHaveClass(/site-header--overlay/);
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('.hero--banner h1')).toHaveAttribute('aria-label', 'Ideas, made real');
  await expect(page.locator('.hero--banner .hero__cta')).toHaveAttribute('href', '#categories');
  await expect(page.locator('.hero__alt')).toHaveAttribute('href', '#inquiry');
  // The proof band's rating is text only: no fabricated review data in the structured data.
  const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
  expect(ld.join('')).not.toContain('AggregateRating');
});
