import { expect, test } from '@playwright/test';
import { DEFAULT_OG_IMAGE } from '../../src/lib/seo/ogImage';
import { ROUTES, isArabic } from './publicRoutes';

/*
 * Every public page names ONE usable share image (owner decision H2; src/lib/seo/ogImage.ts).
 *
 * What this guards (found 2026-10-03): no page outside the services, case studies and posts
 * had an og:image at all, so a shared Home, About or Contact link unfurled as bare text —
 * and a site default authored in Admin would have outranked every service poster and
 * case-study banner. Now: the page's own image where it has one, else the logo card.
 *
 * The origin comes from each page's own og:url, never from PREVIEW_URL: the build inlines
 * PUBLIC_SITE_URL (.env decides it locally, the job's env in CI), and the preview may run on
 * another port. Images are fetched by path from the preview itself for the same reason.
 */

/** Routes whose seeded row has its own image — a poster or a banner frame. */
const OWN_IMAGE = new Set([
  '/services/logo',
  '/ar/services/logo',
  '/portfolio/the-rider',
  '/ar/portfolio/the-rider',
]);

const unescapeHtml = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** The content of every `<meta {attribute}="{key}">` — keys are fixed `og:…`/`twitter:…` names. */
function metas(html: string, attribute: 'property' | 'name', key: string): string[] {
  const re = new RegExp(`<meta ${attribute}="${key}" content="([^"]*)"`, 'g');
  return [...html.matchAll(re)].map((m) => unescapeHtml(m[1]!));
}

for (const route of ROUTES) {
  test(`one usable share image on ${route}`, async ({ request }) => {
    const res = await request.get(route);
    expect(res.status(), route).toBe(route.endsWith('/404') ? 404 : 200);
    const html = await res.text();

    const ogUrl = metas(html, 'property', 'og:url');
    expect(ogUrl, `og:url on ${route}`).toHaveLength(1);
    const origin = new URL(ogUrl[0]!).origin;

    const og = metas(html, 'property', 'og:image');
    expect(og, `og:image on ${route}`).toHaveLength(1);
    expect(metas(html, 'name', 'twitter:image'), `twitter:image on ${route}`).toEqual(og);
    const image = new URL(og[0]!); // absolute, or this throws
    expect(image.protocol).toMatch(/^https?:$/);

    const card = `${origin}${DEFAULT_OG_IMAGE.path}`;
    if (OWN_IMAGE.has(route)) {
      expect(og[0], `${route} shares its own image`).not.toBe(card);
      expect(image.origin, `${route}'s image is served by the site`).toBe(origin);
    } else {
      expect(og[0], `${route} shares the logo card`).toBe(card);
      expect(metas(html, 'property', 'og:image:type')).toEqual([DEFAULT_OG_IMAGE.type]);
      expect(metas(html, 'property', 'og:image:width')).toEqual([String(DEFAULT_OG_IMAGE.width)]);
      expect(metas(html, 'property', 'og:image:height')).toEqual([String(DEFAULT_OG_IMAGE.height)]);
      const alt = metas(html, 'property', 'og:image:alt');
      expect(alt).toHaveLength(1);
      expect(alt[0]).toMatch(isArabic(route) ? /^شعار \S/ : /\S logo$/);
      expect(metas(html, 'name', 'twitter:image:alt')).toEqual(alt);
    }

    const fetched = await request.get(`${image.pathname}${image.search}`);
    expect(fetched.status(), `${og[0]} answers`).toBe(200);
    expect(fetched.headers()['content-type']).toMatch(/^image\//);
  });
}

test('the logo card is a light JPEG', async ({ request }) => {
  const res = await request.get(DEFAULT_OG_IMAGE.path);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe(DEFAULT_OG_IMAGE.type);
  const body = await res.body();
  expect(body.byteLength).toBeLessThan(100_000);
  expect([body[0], body[1]]).toEqual([0xff, 0xd8]); // the JPEG SOI marker
});
