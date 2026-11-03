import { expect, test } from '@playwright/test';

/*
 * A custom page (Admin v2 E11, `/<slug>` and `/ar/<slug>`): the seeded sample, `how-we-work`
 * (supabase/seed-data/57-custom-page.json: a banner hero and a text block, published locally,
 * in CI and on staging). Served as Tier A HTML: its one <h1>, the text block, its
 * self-canonical with reciprocal hreflang and x-default, WebPage and BreadcrumbList JSON-LD in
 * the page's language, and the Cache-Tags a publish purges. An address no custom page may take,
 * or no page has, is the site's 404. axe, served-html, share-image and preview parity cover it
 * through publicRoutes.ts and tests/a11y/axe.e2e.ts; lhci gates both routes.
 */

const SLUG = 'how-we-work';

const STR = {
  en: {
    path: `/${SLUG}`,
    h1: 'How we work',
    heading: 'Every project starts with a conversation',
    body: 'We start by listening',
    home: 'Home',
  },
  ar: {
    path: `/ar/${SLUG}`,
    h1: 'كيف نشتغل',
    heading: 'كل مشروع يبدأ بحوار',
    body: 'نبدأ بالاستماع',
    home: 'الرئيسية',
  },
} as const;

type Node = Record<string, unknown>;

/** Every JSON-LD node of the served HTML, flattened. */
function jsonLd(html: string): Node[] {
  return [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
    .flatMap((m) => {
      const data = JSON.parse(m[1] ?? 'null') as unknown;
      return Array.isArray(data) ? data : [data];
    })
    .filter((n): n is Node => typeof n === 'object' && n !== null);
}

const pathOf = (href: string) => new URL(href).pathname;

for (const locale of ['en', 'ar'] as const) {
  const s = STR[locale];

  test.describe(`custom page, ${locale}`, () => {
    test('Tier A HTML: one h1, the text block, its head and its JSON-LD', async ({ request }) => {
      const res = await request.get(s.path);
      expect(res.status()).toBe(200);
      expect(res.headers()['cache-control']).toContain('s-maxage');
      const tags = (res.headers()['cache-tag'] ?? '').split(',');
      for (const tag of ['route:page', `page:${SLUG}`, `locale:${locale}`, 'media:all']) {
        expect(tags, tag).toContain(tag);
      }
      const html = await res.text();
      expect(html).toContain(`<html lang="${locale}"`);
      expect([...html.matchAll(/<h1\b/g)]).toHaveLength(1);
      expect(html).toContain(`aria-label="${s.h1}"`);
      expect(html).toContain(s.heading);
      expect(html).toContain(s.body);

      // The head: a self-canonical in its language, and both twins plus x-default.
      const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1] ?? '';
      expect(canonical, 'a canonical is present').not.toBe('');
      expect(pathOf(canonical)).toBe(s.path);
      const alternates = Object.fromEntries(
        [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"/g)].map((m) => [
          m[1],
          pathOf(m[2] ?? ''),
        ]),
      );
      expect(alternates).toEqual({ en: `/${SLUG}`, ar: `/ar/${SLUG}`, 'x-default': `/${SLUG}` });

      // JSON-LD: the page, in its language, and its crumbs (Home > the page).
      const nodes = jsonLd(html);
      const webPage = nodes.find((n) => n['@type'] === 'WebPage');
      expect(webPage, 'a WebPage node').toBeDefined();
      expect(webPage).toMatchObject({ name: s.h1, inLanguage: locale });
      expect(pathOf(String(webPage?.['url']))).toBe(s.path);
      const crumbs = nodes.find((n) => n['@type'] === 'BreadcrumbList');
      expect(crumbs, 'a BreadcrumbList node').toBeDefined();
      const items = (crumbs?.['itemListElement'] ?? []) as Node[];
      expect(items.map((i) => i['name'])).toEqual([s.home, s.h1]);
    });

    test('the h1 is the banner hero’s headline, on screen', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const res = await page.goto(s.path);
      expect(res?.status()).toBe(200);
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page.locator('h1')).toHaveAttribute('aria-label', s.h1);
      await expect(page.locator('h1')).toBeVisible();
    });
  });
}

test.describe('addresses that are not a custom page', () => {
  // No such page; a word the site reserves (refused before any read); a slug written in
  // capitals; a route page's slug (its page lives at its own route, never at /<slug>).
  for (const path of [
    '/no-such-page-e2e',
    '/ar/no-such-page-e2e',
    '/feed',
    '/ar/www',
    '/How-We-Work',
    '/home',
    '/portfolio-all',
  ]) {
    test(`${path} answers the site’s 404`, async ({ request }) => {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(404);
      expect(res.headers()['cache-tag'] ?? '', path).not.toContain('route:page');
    });
  }
});
