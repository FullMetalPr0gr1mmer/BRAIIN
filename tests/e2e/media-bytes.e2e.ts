import { expect, test, type Page, type Request } from '@playwright/test';

/*
 * CLAUDE.md §9: "CI asserts zero video bytes before intersection." Until this file existed
 * nothing asserted it — the budget was a comment in lazyVideo.ts.
 *
 * What "before intersection" means here, concretely:
 *   - the served HTML contains no <video> (lazyVideo creates the element at mount time,
 *     so a server-rendered <video> is a regression that would start fetching at parse);
 *   - after load, every mounted <video> sits in a container that intersects the viewport
 *     (the hero is on screen at load, so its bytes are allowed — nothing below the fold is);
 *   - a below-the-fold video surface mounts only once it is scrolled into view;
 *   - reduced motion and Save-Data fetch no video bytes at all, even after a full scroll.
 *
 * Video requests are identified by resource type AND by extension: a range request for an
 * mp4 is reported as `media`, but a prefetch or an <a download> would not be.
 */

const ROUTES = [
  '/',
  '/ar',
  '/contact',
  '/ar/contact',
  '/about',
  '/ar/about',
  // Round 2 (S3): the banner loop (on screen at load — allowed); the cards' hover clips and
  // the explorer's in-view clip (collapsed until opened — never before it is on screen)
  '/services',
  '/ar/services',
  // UI v2 PR10: the banner loop (on screen at load — allowed), hover clips on the cards and
  // the intro's in-view clips (below the fold — never before intersection)
  '/portfolio',
  '/ar/portfolio',
  '/portfolio/all',
  '/ar/portfolio/all',
  // UI v2 PR11: the case-study banner loop (on screen at load) and the final film (an in-view
  // clip below the fold)
  '/portfolio/the-rider',
  '/ar/portfolio/the-rider',
] as const;
// Pages with a below-the-fold background video surface to scroll to.
const BELOW_FOLD: Record<string, string> = {
  '/': '.slogan__media',
  '/ar': '.slogan__media',
  // Our Work's first intro frame (an in-view clip — clips.ts mounts it at 25 % visible)
  '/portfolio': '.work-intro__a',
  // The case study's final film (clips.ts mounts it at 30 % visible)
  '/portfolio/the-rider': '.cs-final .mf',
};

const isVideoRequest = (r: Request) =>
  r.resourceType() === 'media' || /\.(mp4|webm|m3u8|mov)(\?|$)/i.test(r.url());

function collectVideo(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (isVideoRequest(r)) seen.push(r.url());
  });
  return seen;
}

async function settle(page: Page) {
  // The hero mounts its loop after `load`; give the deferred module a beat to run.
  await page.waitForLoadState('load');
  await page.waitForTimeout(1500);
}

async function scrollThrough(page: Page) {
  // Step, don't jump: IntersectionObserver must actually see each section pass.
  const height = await page.evaluate(() => document.scrollingElement!.scrollHeight);
  const step = await page.evaluate(() => Math.round(innerHeight * 0.6));
  for (let y = 0; y <= height; y += step) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(800);
}

async function offscreenVideos(page: Page): Promise<number> {
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

for (const route of ROUTES) {
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

for (const [route, selector] of Object.entries(BELOW_FOLD)) {
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

// Round 2 (S3): /services has no background surface below the fold — its clips are the
// cards' (hover only) and the explorer's (in view, inside a panel that is collapsed until
// opened). So a full scroll with the pointer parked fetches no video at all, and an opened
// panel's clip mounts only once that panel is on screen.
for (const route of ['/services', '/ar/services']) {
  test(`${route}: the cards and the collapsed explorer fetch no video until asked`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(route, { waitUntil: 'load' });
    await settle(page);
    // The pointer parked over the fixed header, so no card is hovered while the page moves.
    // Every clip shares the hero's file, so the check is on the element a clip's bytes
    // need: no <video> exists outside the hero (the hero loop's own requests continue).
    await page.mouse.move(1, 1);
    await scrollThrough(page);
    await expect(page.locator('.svc-xp video, .disc-card video')).toHaveCount(0);

    await page.evaluate(() => document.getElementById('consent-banner')?.remove());
    await page.locator('.disc-card[data-disc="events"]').focus();
    await page.keyboard.press('Enter');
    const frame = page.locator('.svc-panel#events .svc-xp__mf');
    await frame.scrollIntoViewIfNeeded();
    await expect(frame.locator('video')).toHaveCount(1, { timeout: 5000 });
    // Only the opened panel's clip: the four hidden panels never mount theirs.
    await expect(page.locator('.svc-xp video')).toHaveCount(1);
  });
}
