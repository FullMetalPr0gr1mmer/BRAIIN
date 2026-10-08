import { expect, test } from '@playwright/test';

/*
 * CLAUDE.md §6: "Poster image ≤ 80 KB". Lighthouse asserts no per-image size, so until this
 * file the budget was a table row nothing checked.
 *
 * The poster on each page that has one — About's "who we are" poster, Our Work's banner, a
 * case study's banner — is its LCP image, and the only `fetchpriority=high` image there
 * (MediaImage `priority`). The bytes are what the browser received for the candidate it
 * picked (Resource Timing's encodedBodySize: the AVIF/WebP derivative, not the source
 * still), at 2× so it picks the largest one the srcset offers — what a retina screen pays.
 *
 * It bounds what the code controls: this build's image pipeline under `wrangler dev`, not
 * Cloudflare Images in production, and not a Stream thumbnail (EXC-009's close condition).
 * The posters are seeded content (the code defaults carry none), so this needs the seeded
 * local database the perf-seo-a11y e2e job runs against.
 */

const POSTER_BUDGET = 80 * 1024;

const ROUTES = [
  '/about',
  '/ar/about',
  '/portfolio',
  '/ar/portfolio',
  '/portfolio/the-rider',
  '/ar/portfolio/the-rider',
] as const;

test.use({ deviceScaleFactor: 2 });

for (const route of ROUTES) {
  test(`${route}: the high-priority poster is ≤ 80 KB as served`, async ({ page }) => {
    await page.goto(route, { waitUntil: 'load' });
    const posters = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLImageElement>('img[fetchpriority="high"]')].map((img) => {
        const [entry] = performance.getEntriesByName(img.currentSrc, 'resource');
        return {
          src: img.currentSrc,
          bytes: (entry as PerformanceResourceTiming | undefined)?.encodedBodySize ?? 0,
        };
      }),
    );
    expect(posters.length, 'a fetchpriority=high poster (the LCP image)').toBeGreaterThan(0);
    for (const { src, bytes } of posters) {
      expect(bytes, `${src}: no bytes in Resource Timing`).toBeGreaterThan(0);
      expect(bytes, src).toBeLessThanOrEqual(POSTER_BUDGET);
    }
  });
}
