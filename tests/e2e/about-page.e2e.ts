import { expect, test } from '@playwright/test';

/*
 * /about and /ar/about (UI v2 PR8): who we are → leadership → our reach → follow.
 *
 * Runs against supabase/seed.sql, where the about composition (51-about.json), the six
 * placeholder leaders and the three "about" statistics are all published — so the
 * assertions below are on seeded content. The pure halves (slider geometry, JSON-LD,
 * schemas) are tests/lib/aboutPage.spec.ts.
 */

const PAGE = {
  en: {
    path: '/about',
    heroFont: '/fonts/archivo-var-latin.woff2',
    h1: 'Born in Jeddah. Built to move ideas from the brain into the real world.',
    accent: 'from the brain into the real world.',
    leadershipHeading: 'Meet our leadership team',
    roles: ['Founder & CEO', 'Creative Director', 'Head of Production'],
    reach: [
      ['250+', 'Projects delivered across the region'],
      ['80+', "Brands we've partnered with"],
      ['12', 'Countries our work has reached'],
    ],
    follow: 'See the work as it happens',
    next: 'Next',
    prev: 'Previous',
    forward: 'ArrowRight',
  },
  ar: {
    path: '/ar/about',
    // The weight-600 h1 renders with Almarai 700 — not Home's 800 (CLS, docs/fonts.md).
    heroFont: '/fonts/almarai-700-arabic.woff2',
    h1: 'وُلدنا في جدة. وُجدنا لننقل الأفكار من الدماغ إلى أرض الواقع.',
    accent: 'من الدماغ إلى أرض الواقع.',
    leadershipHeading: 'تعرّف على فريق القيادة',
    roles: ['المؤسس والرئيس التنفيذي', 'المدير الإبداعي', 'رئيس الإنتاج'],
    reach: [
      ['250+', 'مشروع منجز في المنطقة'],
      ['80+', 'علامة اشتغلنا معها'],
      ['12', 'دولة وصلها شغلنا'],
    ],
    follow: 'شوف الشغل وهو يصير',
    next: 'التالي',
    prev: 'السابق',
    forward: 'ArrowLeft',
  },
} as const;

for (const locale of ['en', 'ar'] as const) {
  const P = PAGE[locale];

  test.describe(`About — ${locale}`, () => {
    test('sections render in the mockup order, server-side', async ({ page }) => {
      await page.goto(P.path);
      const order = await page.$$eval('main > section', (els) =>
        els.map((el) => el.id || el.className.split(' ')[0]),
      );
      expect(order).toEqual(['who', 'team', 'sb', 'social-strip']);
      await expect(page.locator('.social-strip')).toHaveClass(/social-strip--klein/);
    });

    for (const [width, height] of [
      [1366, 900],
      [412, 915],
    ] as const) {
      test(`the "who" kicker sits where the design's does — ${width}px`, async ({ page }) => {
        // The mockup's fixed header lets clamp(150px, 22vh, 220px) run from the page top;
        // ours is in flow, so the padding subtracts the header's REAL height
        // (--bs-header-h). A flat 72px token put the block 31px (13px on a phone) low.
        await page.setViewportSize({ width, height });
        await page.goto(P.path);
        const y = (await page.locator('#who .tag').boundingBox())!.y;
        expect(Math.abs(y - Math.min(220, Math.max(150, height * 0.22)))).toBeLessThan(4);
      });
    }

    test('the h1 is named by its full text; the split words are hidden from AT', async ({
      page,
    }) => {
      await page.goto(P.path);
      const h1 = page.locator('h1');
      await expect(h1).toHaveCount(1);
      await expect(h1).toHaveAttribute('aria-label', P.h1);
      await expect(h1).toHaveAccessibleName(P.h1);
      await expect(h1.locator('> span')).toHaveAttribute('aria-hidden', 'true');
      await expect(h1.locator('em')).toHaveText(P.accent);
    });

    test('the "who" poster is the eager LCP image, never reveal-gated', async ({ page }) => {
      await page.goto(P.path);
      const frame = page.locator('.about-who .mf');
      await expect(frame).toHaveCount(1);
      await expect(frame).not.toHaveClass(/\brv\b/);
      const img = frame.locator('img');
      await expect(img).toHaveAttribute('loading', 'eager');
      await expect(img).toHaveAttribute('fetchpriority', 'high');
      await expect(img).toHaveAttribute('width', /\d+/);
      await expect(img).toHaveAttribute('height', /\d+/);
      // The clip is a window of the showreel, mounted only by clips.ts.
      await expect(frame).toHaveAttribute('data-clip-start', '6.2');
      await expect(frame).toHaveAttribute('data-clip-end', '7.9');
      // ...and not before `load`, so its bytes never compete with this poster.
      await expect(frame).toHaveAttribute('data-clip-after-load', '');
    });

    test('exactly one font preload: the face the h1 renders in', async ({ request }) => {
      const html = await (await request.get(P.path)).text();
      const preloads = [...html.matchAll(/<link[^>]*rel="preload"[^>]*as="font"[^>]*>/g)];
      expect(preloads).toHaveLength(1);
      expect(preloads[0]![0]).toContain(`href="${P.heroFont}"`);
    });

    test('reach numbers and their About labels are in the served HTML', async ({ request }) => {
      const html = await (await request.get(P.path)).text();
      for (const [value, label] of P.reach) {
        // Astro escapes the apostrophe in "we've".
        const escaped = label.replace(/'/g, "(?:'|&#39;|&#x27;)");
        expect(html).toMatch(new RegExp(escaped));
        expect(html).toContain(`<span class="sr-only">${value}</span>`);
      }
      expect(html).not.toMatch(
        /Crafts under one roof|حرفة تحت سقف واحد|Services under one roof|خدمة تحت سقف واحد/,
      );
    });

    test('leadership cards are server-rendered; without LinkedIn they take no tab stop', async ({
      page,
    }) => {
      await page.goto(P.path);
      await expect(page.locator('#team-heading')).toHaveText(P.leadershipHeading);
      const cards = page.locator('.leader');
      await expect(cards).toHaveCount(6);
      for (const [i, role] of P.roles.entries()) {
        await expect(cards.nth(i).locator('.leader__r')).toHaveText(role);
      }
      // The seeded leaders have no LinkedIn URL: no link, no tabindex, no badge.
      await expect(page.locator('.leader a')).toHaveCount(0);
      await expect(page.locator('.leader [tabindex]')).toHaveCount(0);
      await expect(page.locator('.leader__in')).toHaveCount(0);
      // The scroller itself is keyboard-reachable and named.
      const track = page.locator('[data-slider-track]');
      await expect(track).toHaveAttribute('tabindex', '0');
      await expect(track).toHaveAttribute('role', 'region');
    });

    test('a photo-less card keeps its slate-blue frame (only a photo is greyed)', async ({
      page,
    }) => {
      await page.goto(P.path);
      // The saturation layer sat over the whole frame, so the placeholder gradient and
      // silhouette rendered grey and turned blue on hover. It now exists only over a photo.
      const layers = await page.$$eval('.leader__ph', (els) =>
        els.map((el) => ({
          photo: el.querySelector('img') !== null,
          layer: getComputedStyle(el, '::before').content !== 'none',
        })),
      );
      expect(layers.length).toBeGreaterThan(0);
      for (const { photo, layer } of layers) expect(layer).toBe(photo);
    });

    test('slider: counter, arrows and keys move one card in the reading direction', async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1366, height: 900 });
      await page.goto(P.path);
      const nav = page.locator('[data-slider-nav]');
      await expect(nav).toBeVisible(); // 6 cards, 4 per view: it overflows
      const current = nav.locator('[data-slider-current]');
      await expect(current).toHaveText('01');
      await expect(nav.locator('[data-slider-total]')).toHaveText('06');
      const prev = nav.getByRole('button', { name: P.prev });
      const next = nav.getByRole('button', { name: P.next });
      await expect(prev).toHaveAttribute('aria-disabled', 'true');
      await expect(next).toHaveAttribute('aria-disabled', 'false');

      await next.click();
      await expect(current).toHaveText('02');
      await expect(prev).toHaveAttribute('aria-disabled', 'false');

      await page.locator('[data-slider-track]').focus();
      await page.keyboard.press(P.forward);
      await expect(current).toHaveText('03');
      await expect(next).toHaveAttribute('aria-disabled', 'true');
      // At the end, focus stays on the (aria-)disabled button instead of falling to <body>,
      // and activating it does nothing.
      await next.focus();
      await page.keyboard.press('Enter');
      await expect(next).toBeFocused();
      await expect(current).toHaveText('03');
    });

    test('progress bar moves by transform only', async ({ page }) => {
      await page.setViewportSize({ width: 1366, height: 900 });
      await page.goto(P.path);
      const bar = page.locator('[data-slider-bar]');
      const before = await bar.evaluate((el) => ({
        transform: getComputedStyle(el).transform,
        width: el.getBoundingClientRect().width,
        track: el.parentElement!.getBoundingClientRect().width,
        margin: getComputedStyle(el).marginInlineStart,
      }));
      expect(before.transform).not.toBe('none');
      expect(before.margin).toBe('0px');
      await page.locator('[data-slider-next]').click();
      await expect(page.locator('[data-slider-current]')).toHaveText('02');
      const after = await bar.evaluate((el) => getComputedStyle(el).marginInlineStart);
      expect(after).toBe('0px');
    });

    test('follow band: Klein copy, handles from the public identity', async ({ page }) => {
      await page.goto(P.path);
      const band = page.locator('.social-strip--klein');
      await expect(band.locator('h2')).toHaveText(P.follow);
      await expect(band.locator('.social-links a')).toHaveCount(4);
      for (const a of await band.locator('.social-links a').all()) {
        await expect(a).toHaveAttribute('href', /^https:\/\//);
        await expect(a).toHaveAttribute('rel', /noopener/);
      }
    });

    test('no Person JSON-LD for a placeholder leader, though its card shows', async ({ page }) => {
      // The six seeded leaders are placeholders ("Name Surname"): their cards render (the
      // test above) but structured data never asserts them as staff (decision 36). Real
      // leaders' nodes — jobTitle, sameAs, image — are tests/lib/aboutPage.spec.ts.
      await page.goto(P.path);
      const people = await page.$$eval('script[type="application/ld+json"]', (nodes) =>
        nodes
          .flatMap((n) => {
            const data = JSON.parse(n.textContent || 'null') as unknown;
            return Array.isArray(data) ? data : [data];
          })
          .filter((d) => (d as { '@type'?: string })['@type'] === 'Person'),
      );
      await expect(page.locator('.leader')).toHaveCount(6);
      expect(people).toHaveLength(0);
    });

    test('reduced motion: the h1 words are simply there', async ({ browser }) => {
      const ctx = await browser.newContext({ reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      await page.goto(P.path);
      const hidden = await page.$$eval(
        'h1 .hw',
        (els) => els.filter((el) => getComputedStyle(el).opacity !== '1').length,
      );
      expect(hidden).toBe(0);
      await ctx.close();
    });

    test('Tier-A cache tags cover the tables the page reads', async ({ request }) => {
      const res = await request.get(P.path);
      const tags = res.headers()['cache-tag'] ?? '';
      for (const tag of ['route:about', 'team:all', 'statistics:all', `locale:${locale}`]) {
        expect(tags).toContain(tag);
      }
    });
  });
}
