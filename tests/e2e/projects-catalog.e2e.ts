import { expect, test, type Page } from '@playwright/test';

/*
 * All projects (/portfolio/all, /ar/portfolio/all) — UI v2 PR10.
 *
 * Seeded catalogue (supabase/seed.sql): 12 published projects — branding on 3 (Notebook,
 * Field Notes, Blueprint), 2026 on 2 (The Rider, Kitchen Hours), no branding in 2026.
 * The server renders a complete, filterable catalogue; JavaScript only applies the same
 * controls in place. The query string is untrusted: only values the catalogue carries
 * ever become a filter, and nothing from it is reflected into the page.
 */

const STR = {
  en: {
    path: '/portfolio/all',
    back: '/portfolio',
    h1: 'All projects',
    accent: 'projects',
    n12: '12 projects',
    n3: '03 projects',
    n2: '02 projects',
    branding: 'Branding',
    remove: 'Remove filter: Branding',
    none: 'No projects match these filters.',
  },
  ar: {
    path: '/ar/portfolio/all',
    back: '/ar/portfolio',
    h1: 'كل المشاريع',
    accent: 'المشاريع',
    // Arabic plural forms (the mockup wrote "مشاريع" for every count)
    n12: '12 مشروعًا',
    n3: '03 مشاريع',
    n2: '02 مشروعان',
    branding: 'الهوية البصرية',
    remove: 'إزالة الفلتر: الهوية البصرية',
    none: 'ما في مشاريع تطابق هذه الفلاتر.',
  },
} as const;

const visibleCards = (page: Page) => page.locator('#projects [data-card]:not([hidden])');
const count = (page: Page) => page.locator('#catalog-count');

for (const locale of ['en', 'ar'] as const) {
  const s = STR[locale];

  test.describe(`All projects — ${locale}`, () => {
    test('the whole catalogue is in the served HTML, Tier-A cached', async ({ request }) => {
      const res = await request.get(s.path);
      expect(res.status()).toBe(200);
      expect(res.headers()['cache-control']).toContain('s-maxage');
      expect(res.headers()['cache-tag']).toContain('route:portfolio-all');
      const html = await res.text();
      expect(html).toContain(`<h1>${s.h1.split(' ')[0]} <em>${s.accent}</em></h1>`);
      expect(html).toContain(s.n12);
      expect(html.match(/data-card[\s=>]/g) ?? []).toHaveLength(12);
      expect(html.match(/<h2 class="pcard__t">/g) ?? []).toHaveLength(12);
      expect(html).toContain(`href="${s.back}"`);
      expect(html).toContain('class="lead-band');
    });

    test('featured projects come first, then catalogue order', async ({ page }) => {
      await page.goto(s.path);
      const slugs = await page
        .locator('#projects [data-card] a.pcard__link')
        .evaluateAll((links) => links.map((a) => a.getAttribute('href')?.split('/').pop()));
      expect(slugs.slice(0, 6)).toEqual([
        'the-rider',
        'kitchen-hours',
        'notebook',
        'ink',
        'terrain',
        'first-light',
      ]);
      expect(slugs).toHaveLength(12);
    });

    test('no JavaScript: a chip link filters, the selects apply with the Apply button', async ({
      browser,
    }) => {
      const ctx = await browser.newContext({ javaScriptEnabled: false });
      const page = await ctx.newPage();
      await page.goto(s.path);
      await page.locator('.fchip[data-v="branding"]').click();
      await expect(page).toHaveURL(new RegExp(`${s.path}\\?service=branding$`));
      await expect(visibleCards(page)).toHaveCount(3);
      await expect(count(page)).toHaveText(s.n3);
      await expect(page.locator('.fpill[data-pill="service"]')).toHaveAttribute(
        'aria-label',
        s.remove,
      );

      await page.goto(s.path);
      await page.locator('select[name="year"]').selectOption('2026');
      await page.locator('.fb__apply').click();
      await expect(page).toHaveURL(/year=2026/);
      await expect(visibleCards(page)).toHaveCount(2);
      await expect(count(page)).toHaveText(s.n2);
      await ctx.close();
    });

    test('a filtered view is private and canonicalised to the bare page', async ({ request }) => {
      const res = await request.get(`${s.path}?service=branding`);
      expect(res.headers()['cache-control']).toContain('no-store');
      expect(res.headers()['cache-tag']).toBeUndefined();
      const html = await res.text();
      const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1] ?? '';
      expect(canonical.endsWith(s.path)).toBe(true);
    });

    test('an injected ?year= is inert; an unknown slug filters nothing', async ({ page }) => {
      let dialog = false;
      page.on('dialog', async (d) => {
        dialog = true;
        await d.dismiss();
      });
      const payload = '<img src=x onerror=alert(1)>';
      const res = await page.goto(`${s.path}?year=${encodeURIComponent(payload)}`);
      expect(res?.headers()['cache-control']).toContain('no-store');
      const html = (await res?.text()) ?? '';
      expect(html).not.toContain('onerror');
      expect(html).not.toContain('<img src=x');
      await expect(page.locator('img[src="x"]')).toHaveCount(0);
      await expect(count(page)).toHaveText(s.n12);
      await expect(page.locator('.fb__active')).toBeHidden();

      await page.goto(`${s.path}?service=hacking&client=nobody`);
      await expect(visibleCards(page)).toHaveCount(12);
      expect(dialog).toBe(false);
    });

    test('with JavaScript: in place, replaceState only, Arabic plurals, focus kept', async ({
      page,
    }) => {
      await page.goto(s.path);
      const before = await page.evaluate(() => history.length);

      await page.locator('select[name="year"]').selectOption('2026');
      await expect(visibleCards(page)).toHaveCount(2);
      await expect(count(page)).toHaveText(s.n2);
      expect(new URL(page.url()).search).toBe('?year=2026');

      // a second facet with no overlap → the empty state
      const chip = page.locator('.fchip[data-v="branding"]');
      await chip.click();
      await expect(visibleCards(page)).toHaveCount(0);
      await expect(page.locator('[data-empty]')).toBeVisible();
      await expect(page.locator('[data-empty] p')).toHaveText(s.none);
      await expect(chip).toBeFocused();

      // clear everything from the empty state: focus falls back to the count
      await page.locator('[data-empty] a').click();
      await expect(visibleCards(page)).toHaveCount(12);
      await expect(count(page)).toHaveText(s.n12);
      await expect(count(page)).toBeFocused();
      expect(new URL(page.url()).search).toBe('');
      expect(await page.evaluate(() => history.length)).toBe(before);
    });

    test('a card tag filters by its value; the pill removes it', async ({ page }) => {
      await page.goto(s.path);
      await page.locator('#projects [data-card] .ftag[data-v="branding"]').first().click();
      await expect(visibleCards(page)).toHaveCount(3);
      await expect(count(page)).toHaveText(s.n3);
      const pill = page.locator('.fpill[data-pill="service"]');
      await expect(pill).toBeVisible();
      await expect(pill).toContainText(s.branding);
      await pill.click();
      await expect(visibleCards(page)).toHaveCount(12);
      await expect(pill).toBeHidden();
      await expect(count(page)).toBeFocused();
    });

    test('the no-JS server filter agrees with the enhancement (same counts)', async ({
      page,
      browser,
    }) => {
      const ctx = await browser.newContext({ javaScriptEnabled: false });
      const noJs = await ctx.newPage();
      await noJs.goto(`${s.path}?service=branding&year=2026`);
      await expect(visibleCards(noJs)).toHaveCount(0);
      await expect(noJs.locator('[data-empty]')).toBeVisible();
      await ctx.close();

      await page.goto(`${s.path}?service=branding`);
      await expect(visibleCards(page)).toHaveCount(3);
    });
  });
}
