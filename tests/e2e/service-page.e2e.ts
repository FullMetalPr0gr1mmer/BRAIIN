import { expect, test, type Page } from '@playwright/test';

/*
 * A service page (/services/[slug], /ar/services/[slug]) — Round 2, S4.
 *
 * Runs against the seeded local database (supabase/seed.sql publishes the design's sample
 * content): Logo Design sits in Branding (8 services, Logo first), has 5 deliverables, 3
 * value points and a published sample case told through the Notebook project. Everything
 * indexable must be in the SERVED HTML (Tier A) — the structural checks read the response
 * body, not the live DOM.
 */

const STR = {
  en: {
    path: '/services/logo',
    prefix: '',
    name: 'Logo Design',
    title: 'Braiin Statiion | Logo Design | Branding',
    crumb: ['Services', 'Branding'],
    what: 'The service',
    intro: 'A logo is a promise you repeat thousands of times, so we make it count.',
    get: 'What you get',
    value: "Why it's worth it",
    caseTag: 'Case study',
    caseTitle: 'A school group rebrand that parents recognized in one term',
    see: 'See the full project',
    did: 'What we did',
    hello: "Let's talk Logo Design",
    moreTag: 'More in Branding',
    more: 'Everything in Branding',
    fab: 'Skip to inquiry',
    category: 'Branding',
  },
  ar: {
    path: '/ar/services/logo',
    prefix: '/ar',
    name: 'تصميم الشعار',
    title: 'بريّن ستيشن | تصميم الشعار | الهوية البصرية',
    crumb: ['الخدمات', 'الهوية البصرية'],
    what: 'الخدمة',
    intro: 'الشعار وعد تكرّره آلاف المرات، فنحرص إنه يستاهل.',
    get: 'وش تستلم',
    value: 'ليش تستاهل',
    caseTag: 'دراسة حالة',
    caseTitle: 'إعادة هوية لمجموعة مدارس صار الأهالي يعرفونها خلال فصل واحد',
    see: 'شوف المشروع كامل',
    did: 'وش سوّينا',
    hello: 'خلّنا نتكلم عن تصميم الشعار',
    moreTag: 'المزيد في الهوية البصرية',
    more: 'كل خدمات الهوية البصرية',
    fab: 'انتقل للطلب',
    category: 'الهوية البصرية',
  },
} as const;

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ');

/** Scroll instantly (the page's smooth scrolling would make every read a race). */
async function scrollToY(page: Page, y: number) {
  await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), y);
}
async function scrollToTopOf(page: Page, selector: string, share = 0) {
  await page.evaluate(
    ([sel, s]) => {
      const el = document.querySelector(sel as string)!;
      const top = el.getBoundingClientRect().top + window.scrollY - innerHeight * (s as number);
      window.scrollTo({ top, behavior: 'instant' });
    },
    [selector, share] as const,
  );
}

for (const locale of ['en', 'ar'] as const) {
  const s = STR[locale];

  test.describe(`Service page — ${locale}`, () => {
    test('every part is in the served HTML, in the mockup’s order (Tier A)', async ({
      request,
    }) => {
      const res = await request.get(s.path);
      expect(res.status()).toBe(200);
      expect(res.headers()['cache-control']).toContain('s-maxage');
      const tags = res.headers()['cache-tag'] ?? '';
      for (const tag of ['route:service', 'service:logo', 'disciplines:all', 'service_cases:all'])
        expect(tags).toContain(tag);
      const html = await res.text();

      const order = [
        'class="hero ',
        'class="svc-what"',
        'class="svc-val"',
        'class="svc-case"',
        'class="hello"',
        'class="svc-more"',
        'class="svc-fab"',
      ].map((marker) => html.indexOf(marker));
      for (const at of order) expect(at).toBeGreaterThan(-1);
      expect([...order].sort((a, b) => a - b)).toEqual(order);

      const body = text(html);
      for (const words of [s.what, s.intro, s.get, s.caseTag, s.caseTitle, s.moreTag])
        expect(body).toContain(words);
      // the loop is created after load, never served
      expect(html.match(/<video[\s>]/gi) ?? []).toHaveLength(0);
      // the preselect is server-rendered
      expect(html).toMatch(/<option value="logo" selected/);
      // every script of the page renders inside the document, none after </html>
      expect(html.trimEnd().endsWith('</html>')).toBe(true);
    });

    test('<title> is brand-first: "{brand} | {Service} | {Discipline}"', async ({ page }) => {
      await page.goto(s.path);
      await expect(page).toHaveTitle(s.title);
    });

    test('the hero: h1 = the service name (letter-split, labelled), crumb, CTA to the case', async ({
      page,
    }) => {
      await page.goto(s.path);
      const h1 = page.locator('h1');
      await expect(h1).toHaveCount(1);
      await expect(h1).toHaveAttribute('aria-label', s.name);
      const crumbs = page.locator('.hero nav.crumb a');
      await expect(crumbs).toHaveText([...s.crumb]);
      await expect(crumbs.nth(0)).toHaveAttribute('href', `${s.prefix}/services`);
      await expect(crumbs.nth(1)).toHaveAttribute('href', `${s.prefix}/services#branding`);
      await expect(page.locator('.hero .hero__cta')).toHaveAttribute('href', '#case');
      await expect(page.locator('.hero a.hero__skip')).toHaveAttribute('href', '#inquiry');
      // its own window of the showreel (seeded 5.9–6.9 s), mounted after load
      const media = page.locator('.hero .hero__media');
      await expect(media).toHaveAttribute('data-video-src', '/media/showreel.mp4');
      await expect(media).toHaveAttribute('data-clip-start', '5.9');
      await expect(media).toHaveAttribute('data-clip-end', '6.9');
    });

    test('what it is: the intro h2, 5 deliverables; the value band: 3 cards', async ({ page }) => {
      await page.goto(s.path);
      await expect(page.locator('#svc-what-heading')).toHaveText(s.intro);
      await expect(page.locator('.svc-get__list li')).toHaveCount(5);
      await expect(page.locator('#svc-val-heading')).toHaveText(s.value);
      await expect(page.locator('#svc-val-heading em')).toHaveCount(1);
      await expect(page.locator('.svc-vcard')).toHaveCount(3);
      await expect(page.locator('.svc-vcard__n')).toHaveText(['01', '02', '03']);
    });

    test('the case block links to its project, and its chips name the client and sector', async ({
      page,
    }) => {
      await page.goto(s.path);
      const block = page.locator('section#case.svc-case');
      await expect(block).toHaveCount(1);
      await expect(block.locator('#svc-case-heading')).toHaveText(s.caseTitle);
      const img = block.locator('a.svc-case__img');
      await expect(img).toHaveAttribute('href', `${s.prefix}/portfolio/notebook`);
      await expect(img).toContainText(s.see);
      await expect(img.locator('img')).toHaveAttribute('loading', 'lazy');
      const chips = block.locator('.svc-case__meta li');
      await expect(chips).toHaveCount(4);
      await expect(chips.nth(0).locator('a')).toHaveAttribute(
        'href',
        `${s.prefix}/portfolio/all?client=client-c`,
      );
      await expect(chips.nth(1).locator('a')).toHaveAttribute(
        'href',
        `${s.prefix}/portfolio/all?sector=education`,
      );
      await expect(chips.nth(2)).toHaveText(s.name);
      await expect(chips.nth(3).locator('a')).toHaveAttribute(
        'href',
        `${s.prefix}/portfolio/notebook`,
      );
      await expect(block.locator('.svc-prob')).toHaveCount(3);
      await expect(block.locator('.svc-res__i')).toHaveCount(3);
    });

    test('on a phone each "what we did" cell shows its label', async ({ page }) => {
      await page.setViewportSize({ width: 412, height: 915 });
      await page.goto(s.path);
      const label = await page
        .locator('.svc-prob__s')
        .first()
        .evaluate((el) => getComputedStyle(el, '::before').content);
      expect(label).toContain(s.did);
    });

    test('"Let’s talk {service}": the form preselects this service', async ({ page }) => {
      await page.goto(s.path);
      await expect(page.locator('#hello-heading')).toHaveText(s.hello);
      await expect(page.locator('#hello-heading em')).toHaveText(s.name);
      await expect(page.locator('#cf-service')).toHaveValue('logo');
    });

    test('more in Branding: 8 rows in order, the current one marked', async ({ page }) => {
      await page.goto(s.path);
      await expect(page.locator('.svc-more .tag')).toHaveText(s.moreTag);
      await expect(page.locator('#svc-more-heading')).toHaveText(s.more);
      const rows = page.locator('.svc-more__row');
      await expect(rows).toHaveCount(8);
      await expect(rows.first()).toHaveClass(/is-here/);
      const current = page.locator('.svc-more__row a[aria-current="page"]');
      await expect(current).toHaveCount(1);
      await expect(current).toHaveAttribute('href', `${s.prefix}/services/logo`);
      await expect(page.locator('a.svc-more__all')).toHaveAttribute('href', `${s.prefix}/services`);
    });

    test('Service + BreadcrumbList JSON-LD, and no rating markup', async ({ request }) => {
      const html = await (await request.get(s.path)).text();
      const nodes = [
        ...html.matchAll(/<script type="application\/ld\+json"[^>]*>([^<]+)<\/script>/g),
      ]
        .flatMap((m) => {
          const parsed = JSON.parse(m[1] ?? 'null') as unknown;
          return Array.isArray(parsed) ? parsed : [parsed];
        })
        .filter(Boolean) as Record<string, unknown>[];
      const service = nodes.find((n) => n['@type'] === 'Service');
      expect(service?.name).toBe(s.name);
      expect(service?.serviceType).toBe(s.name);
      expect(service?.category).toBe(s.category);
      expect(service?.areaServed).toBe('SA');
      expect(service?.inLanguage).toBe(locale);
      expect((service?.provider as { '@type': string })['@type']).toBe('Organization');
      const crumbs = nodes.find((n) => n['@type'] === 'BreadcrumbList');
      expect((crumbs?.itemListElement as unknown[]).length).toBe(3);
      expect(html).not.toMatch(/"@type":\s*"(Review|AggregateRating)"/);
    });

    test('the floating button: hidden at the top, shown mid-page, hidden and inert at and after the form', async ({
      page,
    }) => {
      await page.goto(s.path, { waitUntil: 'load' });
      const fab = page.locator('a.svc-fab');
      await expect(fab).toHaveText(s.fab);
      await expect(fab).toHaveAttribute('href', '#inquiry');

      // top of the page
      await expect(fab).not.toHaveClass(/is-shown/);
      await expect(fab).toHaveAttribute('inert', '');
      await expect(fab).toHaveAttribute('aria-hidden', 'true');

      // mid-page: the value band at the top of the viewport, the form far below
      await scrollToTopOf(page, '.svc-val');
      await expect(fab).toHaveClass(/is-shown/);
      await expect(fab).not.toHaveAttribute('inert', '');
      await expect(fab).not.toHaveAttribute('aria-hidden', 'true');

      // the form comes up
      await scrollToTopOf(page, '#inquiry', 0.5);
      await expect(fab).not.toHaveClass(/is-shown/);
      await expect(fab).toHaveAttribute('inert', '');

      // …and it stays aside below it
      await scrollToTopOf(page, '.svc-more');
      await page.waitForTimeout(300);
      await expect(fab).not.toHaveClass(/is-shown/);
      await expect(fab).toHaveAttribute('inert', '');
      await scrollToY(page, 1_000_000);
      await page.waitForTimeout(300);
      await expect(fab).not.toHaveClass(/is-shown/);
    });

    test('a /services/<slug>#inquiry deep link lands on the form', async ({ page }) => {
      await page.goto(`${s.path}#inquiry`, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      const top = await page.locator('#inquiry').evaluate((el) => el.getBoundingClientRect().top);
      expect(Math.abs(top)).toBeLessThan(40);
      await expect(page.locator('#hello-heading')).toBeInViewport();
      await expect(page.locator('#cf-service')).toHaveValue('logo');
    });
  });
}

test.describe('Service URLs — retired slugs and unknown ones', () => {
  test('/services/branding → 301 to the Branding panel on /services', async ({ request }) => {
    const res = await request.get('/services/branding', { maxRedirects: 0 });
    expect(res.status()).toBe(301);
    expect(res.headers()['location']).toBe('/services#branding');
    expect(res.headers()['cache-control']).toBe('public, max-age=86400');
  });

  test('/ar/services/music → 301 to /ar/services/music-vo-sfx', async ({ request }) => {
    const res = await request.get('/ar/services/music', { maxRedirects: 0 });
    expect(res.status()).toBe(301);
    expect(res.headers()['location']).toBe('/ar/services/music-vo-sfx');
  });

  for (const [path, lang] of [
    ['/services/nope', 'en'],
    ['/ar/services/nope', 'ar'],
  ] as const) {
    test(`${path} is a real 404 in its language`, async ({ request }) => {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status()).toBe(404);
      const html = await res.text();
      expect(html).toContain(`<html lang="${lang}"`);
      expect(html).not.toContain('class="svc-what"');
    });
  }

  test('a retired slug’s new page answers 200 (EN and AR)', async ({ request }) => {
    for (const path of ['/services/music-vo-sfx', '/ar/services/photo-video']) {
      expect((await request.get(path)).status(), path).toBe(200);
    }
  });
});
