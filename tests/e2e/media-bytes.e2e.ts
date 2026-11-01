import { expect, test } from '@playwright/test';
import { describeVideoBytes, scrollThrough, settle, testMountsOnIntersection } from './videoBytes';

/*
 * CLAUDE.md §9: "CI asserts zero video bytes before intersection." Until this file existed
 * nothing asserted it — the budget was a comment in lazyVideo.ts.
 *
 * The battery itself (what "before intersection" means, and how a video request is told
 * apart) is ./videoBytes.ts, shared with tests/admin/section-blocks.e2e.ts, which runs it on
 * About while Admin v2 E10's Video block is on it. This file runs it on every seeded route.
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
  // Round 2 (S4): the service hero's banner loop (on screen at load — allowed; it mounts
  // after `load`), and in-content images that are lazy
  '/services/logo',
  '/ar/services/logo',
  // Join: the banner loop (on screen at load — allowed; it mounts after `load`)
  '/join',
  '/ar/join',
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

for (const route of ROUTES) describeVideoBytes(route);

for (const [route, selector] of Object.entries(BELOW_FOLD)) {
  testMountsOnIntersection(route, selector);
}

// Round 2 (S4): on a service page the hero's backdrop is CSS and its loop mounts after
// `load` (above), so every <img> in the page's content — the case block's poster — must be
// lazy: nothing below the hero may compete with the h1 (the LCP element) for bandwidth.
for (const route of ['/services/logo', '/ar/services/logo']) {
  test(`${route}: every in-content image is lazy`, async ({ request }) => {
    const html = await (await request.get(route)).text();
    const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
    const imgs = main.match(/<img\b[^>]*>/g) ?? [];
    expect(imgs.length, 'the case block poster').toBeGreaterThan(0);
    for (const img of imgs) expect(img).toMatch(/\sloading="lazy"/);
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
