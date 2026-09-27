import { expect, test } from '@playwright/test';

/*
 * The case study (/portfolio/[slug], /ar/portfolio/[slug]) — UI v2 PR11.
 *
 * Runs against the seeded local database (supabase/seed.sql publishes the design's sample
 * content): The Rider has a hero and final clip, 4 keywords, 5 scope items, 2 result
 * cards, a published quote, 6 breakdown stills and 9 gallery stills; the next project in
 * catalogue order is Kitchen Hours. Everything indexable must be in the SERVED HTML
 * (Tier A) — the structural checks read the response body, not the live DOM.
 */

const STR = {
  en: {
    path: '/portfolio/the-rider',
    home: '/',
    name: 'The Rider',
    caption: 'The Rider | Brand film',
    tag: 'Case study',
    keywords: ['Brand film', 'Launch', 'Desert shoot', 'Art direction'],
    h2: ['Overview', 'Scope of work', 'The goal', 'The result'],
    industry: 'Industry',
    sector: 'Automotive',
    client: 'Client A',
    lead: 'A launch film built around one image',
    scope: 'Creative concept',
    final: 'Final film',
    quote: 'They came back with a film that felt like it was made for this region',
    author: 'Client name',
    role: 'Marketing Director, Company',
    breakdown: 'From the first sketch to set',
    breakdownLead: 'How the idea got made: the sketches, the tests, and the days on set.',
    sketch: 'Sketch',
    gallery: 'Stills from the final',
    stills: '09 stills',
    next: 'Kitchen Hours',
    nextLabel: 'Next project: Kitchen Hours',
    leadBand: 'Your idea could be',
    close: 'Close',
    viewer: 'Image viewer',
    back: 'All projects',
  },
  ar: {
    path: '/ar/portfolio/the-rider',
    home: '/ar',
    name: 'الراكب',
    caption: 'الراكب | فيلم للعلامة',
    tag: 'دراسة حالة',
    keywords: ['فيلم للعلامة', 'إطلاق', 'تصوير صحراوي', 'إخراج فني'],
    h2: ['نظرة عامة', 'نطاق العمل', 'الهدف', 'النتيجة'],
    industry: 'القطاع',
    sector: 'السيارات',
    client: 'العميل أ',
    lead: 'فيلم إطلاق مبني حول صورة واحدة',
    scope: 'الفكرة الإبداعية',
    final: 'الفيلم النهائي',
    quote: 'رجعوا بفيلم يحسسك أنه مصنوع لهذه المنطقة',
    author: 'اسم العميل',
    role: 'مدير التسويق، الشركة',
    breakdown: 'من أول رسمة إلى موقع التصوير',
    breakdownLead: 'كيف انصنعت الفكرة: الرسومات والتجارب وأيام التصوير.',
    sketch: 'رسمة',
    gallery: 'لقطات من العمل النهائي',
    stills: '09 لقطات',
    next: 'ساعات المطبخ',
    nextLabel: 'المشروع التالي: ساعات المطبخ',
    leadBand: 'فكرتك ممكن تكون',
    close: 'إغلاق',
    viewer: 'عارض الصور',
    back: 'كل المشاريع',
  },
} as const;

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ');

for (const locale of ['en', 'ar'] as const) {
  const s = STR[locale];
  const base = locale === 'ar' ? '/ar/portfolio' : '/portfolio';

  test.describe(`Case study — ${locale}`, () => {
    test('every part is in the served HTML, in the mockup’s order (Tier A)', async ({
      request,
    }) => {
      const res = await request.get(s.path);
      expect(res.status()).toBe(200);
      expect(res.headers()['cache-control']).toContain('s-maxage');
      const tags = res.headers()['cache-tag'] ?? '';
      expect(tags).toContain('route:portfolio-item');
      expect(tags).toContain('portfolio:the-rider');
      expect(tags).toContain('testimonials:all');
      const html = await res.text();

      const order = [
        'class="mbanner cs-banner"',
        'class="cs-title"',
        'class="cs-ov',
        'class="cs-quote',
        'class="cs-bd"',
        'class="cs-gal"',
        'class="cs-next"',
        'class="lead-band',
      ].map((marker) => html.indexOf(marker));
      for (const at of order) expect(at).toBeGreaterThan(-1);
      expect([...order].sort((a, b) => a - b)).toEqual(order);

      const body = text(html);
      expect(body).toContain(s.caption);
      expect(body).toContain(s.tag);
      expect(body).toContain(s.lead);
      expect(body).toContain(s.scope);
      expect(body).toContain(s.quote);
      expect(body).toContain(s.breakdownLead);
      expect(body).toContain(s.stills);
      expect(body).toContain(s.leadBand);
      // no <video> is ever served: the loops are created after load / on intersection
      expect(html.match(/<video[\s>]/gi) ?? []).toHaveLength(0);
      // the mockup's sound toggle and any Stream player are not shipped (KAN-20)
      expect(html).not.toContain('<iframe');
      expect(html).not.toMatch(/class="[^"]*\bstream\b/);
    });

    test('h1 is the project name; the overview blocks are real h2 headings', async ({ page }) => {
      await page.goto(s.path);
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page.locator('h1')).toHaveText(s.name);
      await expect(page.locator('.cs-ov h2')).toHaveText([...s.h2]);
      await expect(page.locator('.cs-scope li')).toHaveCount(5);
      await expect(page.locator('.cs-res li')).toHaveCount(2);
      await expect(page.locator('.cs-final figcaption')).toContainText(s.final);
      await expect(page.locator('.cs-final figcaption')).toContainText('1:30');
    });

    test('keyword chips, then facet links into All projects ("Industry" = the sector)', async ({
      page,
    }) => {
      await page.goto(s.path);
      await expect(page.locator('.cs-kw li')).toHaveText([...s.keywords]);
      const meta = page.locator('.cs-title .facets--case');
      await expect(meta).toContainText(s.industry);
      await expect(meta.locator('a.ftag[data-f="sector"]')).toHaveText(s.sector);
      await expect(meta.locator('a.ftag[data-f="sector"]')).toHaveAttribute(
        'href',
        `${base}/all?sector=automotive`,
      );
      await expect(meta.locator('a.ftag[data-f="service"]')).toHaveCount(2);
      await expect(meta.locator('a.ftag[data-f="client"]')).toHaveText(s.client);
      await expect(meta.locator('a.ftag[data-f="year"]')).toHaveAttribute(
        'href',
        `${base}/all?year=2026`,
      );
      await expect(page.locator('.cs-title__back')).toHaveText(s.back);
      await expect(page.locator('.cs-title__back')).toHaveAttribute('href', `${base}#projects`);
    });

    test('the banner poster is the eager LCP image; the caption points at the title band', async ({
      page,
    }) => {
      await page.goto(s.path);
      const poster = page.locator('.mbanner img');
      await expect(poster).toHaveAttribute('loading', 'eager');
      await expect(poster).toHaveAttribute('fetchpriority', 'high');
      const cap = page.locator('.cs-banner a.work-cap');
      await expect(cap).toHaveAttribute('href', '#title');
      await expect(cap).toContainText(s.caption);
      await expect(page.locator('#title')).toHaveCount(1);
    });

    test('the quote is attributed to a person (name + "Title, Company")', async ({ page }) => {
      await page.goto(s.path);
      const quote = page.locator('.cs-quote');
      await expect(quote.locator('blockquote')).toContainText(s.quote);
      await expect(quote.locator('.cs-quote__n')).toHaveText(s.author);
      await expect(quote.locator('.cs-quote__r')).toHaveText(s.role);
    });

    test('breakdown + gallery: the mockup’s head copy, stills with real alt text', async ({
      page,
    }) => {
      await page.goto(s.path);
      await expect(page.locator('#cs-bd-heading')).toHaveText(s.breakdown);
      await expect(page.locator('#cs-bd-heading em')).toHaveCount(1);
      await expect(page.locator('.cs-bdi')).toHaveCount(6);
      await expect(page.locator('.cs-bdi--sketch .cs-bdi__tag').first()).toHaveText(s.sketch);
      await expect(page.locator('#cs-gal-heading')).toHaveText(s.gallery);
      await expect(page.locator('.cs-gal__count')).toHaveText(s.stills);
      const items = page.locator('.cs-gal__item');
      await expect(items).toHaveCount(9);
      // the rhythm is server-rendered: wide first, then two halves
      await expect(items.nth(0)).toHaveClass(/cs-gal__item--wide/);
      await expect(items.nth(1)).toHaveClass(/cs-gal__item--half/);
      const alts = await page
        .locator('.cs-gal__item img, .cs-bdi img')
        .evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).alt.trim()));
      expect(alts).toHaveLength(15);
      for (const alt of alts) expect(alt.length).toBeGreaterThan(0);
    });

    test('lightbox: a modal dialog — focus inside, arrows, Escape returns focus', async ({
      page,
    }) => {
      await page.goto(s.path);
      const dialog = page.locator('dialog.lightbox');
      await expect(dialog).toHaveAttribute('aria-label', s.viewer);
      await expect(dialog).not.toHaveAttribute('open', '');

      const second = page.locator('.cs-gal__item').nth(1);
      await second.scrollIntoViewIfNeeded();
      await second.focus();
      await page.keyboard.press('Enter');
      await expect(dialog).toHaveAttribute('open', '');
      await expect(page.locator('[data-lb-close]')).toBeFocused();
      await expect(page.locator('[data-lb-close]')).toHaveAttribute('aria-label', s.close);
      await expect(page.locator('[data-lb-count]')).toHaveText('02 / 09');
      const img = dialog.locator('img.lightbox__img');
      await expect(img).toHaveAttribute('src', /.+/);
      expect((await img.getAttribute('alt'))?.length ?? 0).toBeGreaterThan(0);

      // the reading direction decides which arrow is "next"
      await page.keyboard.press(locale === 'ar' ? 'ArrowLeft' : 'ArrowRight');
      await expect(page.locator('[data-lb-count]')).toHaveText('03 / 09');
      await page.keyboard.press(locale === 'ar' ? 'ArrowRight' : 'ArrowLeft');
      await page.keyboard.press(locale === 'ar' ? 'ArrowRight' : 'ArrowLeft');
      await expect(page.locator('[data-lb-count]')).toHaveText('01 / 09');

      // Tab stays inside the dialog
      for (let i = 0; i < 4; i += 1) {
        await page.keyboard.press('Tab');
        const inside = await page.evaluate(
          () => document.activeElement?.closest('dialog.lightbox') !== null,
        );
        expect(inside).toBe(true);
      }

      await page.keyboard.press('Escape');
      await expect(dialog).not.toHaveAttribute('open', '');
      await expect(second).toBeFocused();
    });

    test('without JavaScript a still is a link to its full-size image', async ({ browser }) => {
      const ctx = await browser.newContext({ javaScriptEnabled: false });
      const page = await ctx.newPage();
      await page.goto(s.path);
      const href = await page.locator('.cs-gal__item').first().getAttribute('href');
      expect(href).toMatch(/^\/_image\?|^\/_astro\//);
      await ctx.close();
    });

    test('next project: the whole band links to the next case study', async ({ page }) => {
      await page.goto(s.path);
      const next = page.locator('a.cs-next');
      await expect(next).toHaveAttribute('href', `${base}/kitchen-hours`);
      await expect(next).toHaveAttribute('aria-label', s.nextLabel);
      await expect(next.locator('.cs-next__t')).toHaveText(s.next);
    });

    test('extended CreativeWork JSON-LD + breadcrumb, and no Review markup', async ({
      request,
    }) => {
      const html = await (await request.get(s.path)).text();
      const nodes = [
        ...html.matchAll(/<script type="application\/ld\+json"[^>]*>([^<]+)<\/script>/g),
      ]
        .flatMap((m) => {
          const parsed = JSON.parse(m[1] ?? 'null') as unknown;
          return Array.isArray(parsed) ? parsed : [parsed];
        })
        .filter(Boolean) as Record<string, unknown>[];
      const work = nodes.find((n) => n['@type'] === 'CreativeWork');
      expect(work).toBeDefined();
      expect(work?.name).toBe(s.name);
      expect(String(work?.image)).toMatch(/^https?:\/\//);
      expect(work?.dateCreated).toBe('2026');
      expect(String(work?.keywords)).toContain(s.keywords[0]);
      expect(work?.inLanguage).toBe(locale);
      expect(nodes.find((n) => n['@type'] === 'BreadcrumbList')).toBeDefined();
      expect(html).not.toMatch(/"@type":\s*"(Review|AggregateRating)"/);
    });

    test('an unknown slug is a real 404 in this language', async ({ request }) => {
      const res = await request.get(`${base}/no-such-project`);
      expect(res.status()).toBe(404);
      const html = await res.text();
      expect(html).toContain(`<html lang="${locale}"`);
      expect(html).not.toContain('class="cs-title"');
    });

    test('touch: the final film never fetches video (poster only)', async ({ browser }) => {
      const ctx = await browser.newContext({
        hasTouch: true,
        isMobile: true,
        viewport: { width: 412, height: 860 },
      });
      const page = await ctx.newPage();
      await page.goto(s.path, { waitUntil: 'load' });
      await page.locator('.cs-final').scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);
      await expect(page.locator('.cs-final video')).toHaveCount(0);
      await ctx.close();
    });
  });
}

test('/portfolio/all is still the catalogue, not a case study', async ({ request }) => {
  const res = await request.get('/portfolio/all');
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('class="catalog-head"');
  expect(html).not.toContain('class="cs-title"');
});
