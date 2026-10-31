import { expect, test, type Page, type Request } from '@playwright/test';

/*
 * The zero-video-bytes battery (CLAUDE.md §9: "CI asserts zero video bytes before
 * intersection"), shared by tests/e2e/media-bytes.e2e.ts, which runs it on every seeded public
 * route, and tests/admin/section-blocks.e2e.ts, which runs it on About while Admin v2 E10's
 * Video block is on it (that block is not seeded, so media-bytes' routes never carry one).
 * One copy, so a route with a section block is held to exactly the rules every other route is.
 *
 * What "before intersection" means here, concretely:
 *   - the served HTML contains no <video> (lazyVideo and clips.ts create the element at mount
 *     time, so a server-rendered <video> is a regression that would start fetching at parse);
 *   - after load, every mounted <video> sits in a container that intersects the viewport
 *     (the hero is on screen at load, so its bytes are allowed — nothing below the fold is);
 *   - a below-the-fold video surface mounts only once it is scrolled into view;
 *   - reduced motion and Save-Data fetch no video bytes at all, even after a full scroll.
 *
 * Video requests are identified by resource type AND by extension: a range request for an
 * mp4 is reported as `media`, but a prefetch or an <a download> would not be.
 */

export const isVideoRequest = (r: Request) =>
  r.resourceType() === 'media' || /\.(mp4|webm|m3u8|mov)(\?|$)/i.test(r.url());

export function collectVideo(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (isVideoRequest(r)) seen.push(r.url());
  });
  return seen;
}

export async function settle(page: Page) {
  // The hero mounts its loop after `load`; give the deferred module a beat to run.
  await page.waitForLoadState('load');
  await page.waitForTimeout(1500);
}

export async function scrollThrough(page: Page) {
  // Step, don't jump: IntersectionObserver must actually see each section pass.
  const height = await page.evaluate(() => document.scrollingElement!.scrollHeight);
  const step = await page.evaluate(() => Math.round(innerHeight * 0.6));
  for (let y = 0; y <= height; y += step) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(800);
}

export async function offscreenVideos(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      [...document.querySelectorAll('video')].filter((v) => {
        const box = (v.parentElement ?? v).getBoundingClientRect();
        return (
          box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth
        );
      }).length,
  );
}

/** The four route-wide checks (and the touch one still to come) for one public route. */
export function describeVideoBytes(route: string): void {
  test.describe(`video bytes — ${route}`, () => {
    test('served HTML carries no <video> element', async ({ request }) => {
      const html = await (await request.get(route)).text();
      expect(html.match(/<video[\s>]/gi) ?? [], 'server-rendered <video>').toHaveLength(0);
    });

    test('after load, only on-screen surfaces have mounted video', async ({ page }) => {
      collectVideo(page);
      await page.goto(route, { waitUntil: 'load' });
      await settle(page);
      expect(await offscreenVideos(page), 'a <video> mounted outside the viewport').toBe(0);
    });

    test('reduced motion: zero video bytes, even after a full scroll', async ({ browser }) => {
      const ctx = await browser.newContext({ reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      const seen = collectVideo(page);
      await page.goto(route, { waitUntil: 'load' });
      await settle(page);
      await scrollThrough(page);
      expect(seen, 'video requested under prefers-reduced-motion').toEqual([]);
      expect(await page.locator('video').count()).toBe(0);
      await ctx.close();
    });

    test('Save-Data: zero video bytes, even after a full scroll', async ({ browser }) => {
      const ctx = await browser.newContext();
      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'connection', {
          configurable: true,
          value: { saveData: true },
        });
      });
      const page = await ctx.newPage();
      const seen = collectVideo(page);
      await page.goto(route, { waitUntil: 'load' });
      await settle(page);
      await scrollThrough(page);
      expect(seen, 'video requested with Save-Data on').toEqual([]);
      await ctx.close();
    });

    // In-content clips (work cards, case-study frames) must never autoplay on touch —
    // enabled with lazyVideo v2 (PR6), which introduces the `data-clip-mode` surfaces.
    test.fixme('touch: in-content clips fetch no video bytes', async () => {});
  });
}

/** One below-the-fold video surface: it mounts on intersection, not one viewport early. */
export function testMountsOnIntersection(route: string, selector: string): void {
  test(`${route}: the below-the-fold video mounts on intersection, not before`, async ({
    page,
  }) => {
    await page.goto(route, { waitUntil: 'load' });
    await settle(page);

    const surface = page.locator(selector);
    await expect(surface).toHaveCount(1);

    // Park the surface JUST below the fold — close enough that any "preload on approach"
    // margin would fire, but not intersecting. This is the position that distinguishes
    // "mount on intersection" from "mount one viewport early"; checking only at scrollY=0
    // would pass either way.
    await page.evaluate((sel) => {
      const el = document.querySelector(sel)!;
      const top = el.getBoundingClientRect().top + window.scrollY;
      window.scrollTo(0, Math.max(0, top - innerHeight - 40));
    }, selector);
    await page.waitForTimeout(800);
    expect(await surface.locator('video').count(), 'mounted before it was on screen').toBe(0);

    await surface.scrollIntoViewIfNeeded();
    await expect(surface.locator('video')).toHaveCount(1, { timeout: 5000 });
  });
}
