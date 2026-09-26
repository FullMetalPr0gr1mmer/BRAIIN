import { expect, test, type Page } from '@playwright/test';

/*
 * Our Work (/portfolio, /ar/portfolio) — UI v2 PR10.
 *
 * Runs against the seeded local database (supabase/seed.sql publishes the design's
 * sample content): 12 projects, 6 featured, The Rider the latest; four counters marked
 * for Our Work; three quotes; the page composition from seed-data/53-work-pages.json.
 * Everything indexable must be in the SERVED HTML (Tier A) — most checks read the
 * response body, not the live DOM.
 */

const STR = {
  en: {
    path: '/portfolio',
    h1: 'Our Work',
    caption: 'The Rider | Brand film',
    latest: 'Latest project',
    intro: 'Every project here started as a sketch in a notebook',
    quote: 'They asked better questions about our business',
    lead: 'Your idea could be',
    all6: '06 of 06 featured',
    adv2: '02 of 06 featured',
    photo2: '02 of 06 featured',
    seeAll: 'See all projects',
    seePhoto: 'See all 3 matching projects',
    photography: 'Photography',
  },
  ar: {
    path: '/ar/portfolio',
    h1: 'أعمالنا',
    caption: 'الراكب | فيلم للعلامة',
    latest: 'أحدث مشروع',
    intro: 'كل مشروع هنا بدأ كرسمة في دفتر',
    quote: 'سألونا أسئلة عن شغلنا في أول اجتماع',
    lead: 'فكرتك ممكن تكون',
    all6: '06 من 06 مختارة',
    adv2: '02 من 06 مختارة',
    photo2: '02 من 06 مختارة',
    seeAll: 'شوف كل المشاريع',
    seePhoto: 'شوف كل المشاريع المطابقة (3)',
    photography: 'التصوير الفوتوغرافي',
  },
} as const;

const visibleCards = (page: Page) => page.locator('#projects [data-card]:not([hidden])');

for (const locale of ['en', 'ar'] as const) {
  const s = STR[locale];

  test.describe(`Our Work — ${locale}`, () => {
    test('every section is in the served HTML, in order (Tier A)', async ({ request }) => {
      const res = await request.get(s.path);
      expect(res.status()).toBe(200);
      expect(res.headers()['cache-control']).toContain('s-maxage');
      expect(res.headers()['cache-tag']).toContain('route:portfolio');
      const html = await res.text();

      expect(html).toContain(`<h1 class="sr-only">${s.h1}</h1>`);
      const order = [
        'class="mbanner work-hero"',
        'class="proof',
        'class="work-intro',
        'id="projects"',
        'class="clients"',
        'class="lead-band',
      ].map((marker) => html.indexOf(marker));
      for (const at of order) expect(at).toBeGreaterThan(-1);
      expect([...order].sort((a, b) => a - b)).toEqual(order);

      expect(html).toContain(s.caption);
      expect(html).toContain(s.latest);
      expect(html).toContain(s.intro);
      expect(html).toContain(s.quote);
      expect(html).toContain('250');
      expect(html).toContain(s.lead);
      expect(html).toContain(s.all6);
      // no <video> is ever served: every loop is created after load or on intersection
      expect(html.match(/<video[\s>]/gi) ?? []).toHaveLength(0);
    });

    test('the banner poster is the eager LCP image; the caption links to the case study', async ({
      page,
    }) => {
      await page.goto(s.path);
      const poster = page.locator('.mbanner img');
      await expect(poster).toHaveAttribute('loading', 'eager');
      await expect(poster).toHaveAttribute('fetchpriority', 'high');
      const cap = page.locator('a.work-cap');
      await expect(cap).toHaveAttribute('href', `${s.path}/the-rider`);
      await expect(cap).toContainText(s.caption);
      // the grid renders (featured projects are seeded), so the intro link is in-page
      await expect(page.locator('a.work-intro__link')).toHaveAttribute('href', '#projects');
    });

    test('the caption leaves the tab order once IT is covered, before the banner is (2.4.11)', async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1366, height: 768 });
      await page.goto(s.path);
      const cap = page.locator('a.work-cap');
      const banner = page.locator('.mbanner');
      const { height, top } = await page.evaluate(() => {
        const b = document.querySelector<HTMLElement>('.mbanner');
        const c = document.querySelector<HTMLElement>('.work-cap');
        return { height: b?.offsetHeight ?? 0, top: c?.offsetTop ?? 0 };
      });
      expect(top).toBeGreaterThan(0);
      const scrollTo = (y: number) =>
        page.evaluate((to) => window.scrollTo({ top: to, behavior: 'instant' }), y);
      // the next section's top edge is just below the caption's: still partly visible
      await scrollTo(height - top - 20);
      await expect(cap).toHaveCSS('visibility', 'visible');
      // edge past the caption's top: entirely painted over → hidden, though the banner
      // itself is not yet covered (its loop keeps playing)
      await scrollTo(height - top + 2);
      await expect(cap).toHaveCSS('visibility', 'hidden');
      await expect(banner).not.toHaveClass(/\bis-covered\b/);
      await scrollTo(0);
      await expect(cap).toHaveCSS('visibility', 'visible');
    });

    test('six featured cards, latest first, titles as h3 under the "Projects" h2', async ({
      page,
    }) => {
      await page.goto(s.path);
      await expect(page.locator('#projects [data-card]')).toHaveCount(6);
      await expect(page.locator('#projects [data-card] h3.pcard__t').first()).toContainText(
        s.caption,
      );
      await expect(page.locator('#projects .pgrid__foot a')).toHaveAttribute(
        'href',
        `${s.path}/all`,
      );
      await expect(page.locator('#projects [data-see-all-label]')).toHaveText(s.seeAll);
    });

    test('filters work without JavaScript (links + GET form)', async ({ browser }) => {
      const ctx = await browser.newContext({ javaScriptEnabled: false });
      const page = await ctx.newPage();
      const res = await page.goto(`${s.path}?service=advertising`);
      // a filtered view is never edge-cached, and its canonical is the bare page
      expect(res?.headers()['cache-control']).toContain('no-store');
      expect(res?.headers()['cache-tag']).toBeUndefined();
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        'href',
        new RegExp(`${s.path}$`),
      );
      await expect(visibleCards(page)).toHaveCount(2);
      await expect(page.locator('#projects [data-count]')).toHaveText(s.adv2);
      await expect(page.locator('.fchip[aria-current="true"]')).toHaveAttribute(
        'data-v',
        'advertising',
      );
      await expect(page.locator('#projects .pgrid__foot a')).toHaveAttribute(
        'href',
        `${s.path}/all?service=advertising`,
      );
      // the Apply button is the no-JS path for the selects
      await expect(page.locator('.fb__apply')).toBeVisible();
      await ctx.close();
    });

    test('with JavaScript a chip filters in place: replaceState, focus kept', async ({ page }) => {
      await page.goto(s.path);
      const before = await page.evaluate(() => history.length);
      const chip = page.locator('.fchip[data-v="photography"]');
      await chip.focus();
      await page.keyboard.press('Enter');
      await expect(visibleCards(page)).toHaveCount(2);
      await expect(page.locator('#projects [data-count]')).toHaveText(s.photo2);
      await expect(page.locator('#projects [data-see-all-label]')).toHaveText(s.seePhoto);
      await expect(page.locator('#projects .pgrid__foot a')).toHaveAttribute(
        'href',
        `${s.path}/all?service=photography`,
      );
      expect(new URL(page.url()).search).toBe('?service=photography');
      expect(await page.evaluate(() => history.length)).toBe(before);
      await expect(chip).toBeFocused();
      await expect(chip).toHaveAttribute('aria-current', 'true');
      await expect(page.locator('.fpill[data-pill="service"]')).toContainText(s.photography);
      await expect(page.locator('.fb__apply')).toBeHidden();
    });

    test('an injected ?year= is inert: not reflected, nothing injected', async ({ page }) => {
      let dialog = false;
      page.on('dialog', async (d) => {
        dialog = true;
        await d.dismiss();
      });
      const payload = '<img src=x onerror=alert(1)>';
      const res = await page.goto(`${s.path}?year=${encodeURIComponent(payload)}`);
      const html = (await res?.text()) ?? '';
      expect(html).not.toContain('onerror');
      expect(html).not.toContain('<img src=x');
      await expect(page.locator('img[src="x"]')).toHaveCount(0);
      await expect(visibleCards(page)).toHaveCount(6);
      await expect(page.locator('#projects [data-count]')).toHaveText(s.all6);
      expect(dialog).toBe(false);
    });

    test('touch: in-content clips never fetch video (poster only)', async ({ browser }) => {
      const ctx = await browser.newContext({
        hasTouch: true,
        isMobile: true,
        viewport: { width: 412, height: 860 },
      });
      const page = await ctx.newPage();
      await page.goto(s.path, { waitUntil: 'load' });
      const height = await page.evaluate(() => document.scrollingElement!.scrollHeight);
      for (let y = 0; y <= height; y += 500) {
        await page.evaluate((top) => window.scrollTo(0, top), y);
        await page.waitForTimeout(100);
      }
      await expect(page.locator('.mf video')).toHaveCount(0);
      await expect(page.locator('.mf.can-clip')).toHaveCount(0);
      await ctx.close();
    });

    test('reduced motion: the caption is simply there (its entrance is killed)', async ({
      browser,
    }) => {
      const ctx = await browser.newContext({ reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      await page.goto(s.path);
      const opacity = await page
        .locator('a.work-cap')
        .evaluate((el) => getComputedStyle(el).opacity);
      expect(opacity).toBe('1');
      await ctx.close();
    });
  });
}
