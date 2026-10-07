import { expect, test, type Page } from '@playwright/test';

/*
 * The PDPL consent banner (ConsentBanner.astro; global.css "Consent banner").
 *
 * It shows at once, at every width, before any web font: on a first visit its copy is often
 * the page's LCP candidate (design-port #26 — at phone widths, and on Arabic Contact /
 * Services / Join up to ~1200 px), so it is never held back. And its box does not change when
 * its fonts arrive: the copy's cap is in em, not ch (R3-0), and the Arabic copy's third line
 * is reserved. Drawn by DirectWrite (Windows), that copy is three lines in Almarai and two in
 * the matched fallback wherever the cap applies, and the bar — pinned to the bottom edge —
 * grew upward when Almarai arrived: 79 → 102 px at 1350 px, 131 → 154 px at 768 px (CLS
 * 0.023–0.086). On Linux (CI) FreeType's whole-pixel advances set it in two lines in both, so
 * there these cases hold the em cap and the reservation is held by fontFallbacks.spec.ts.
 * Sampled widths, not every width: a few px-wide bands where the buttons fit beside the copy
 * in one font and not the other stay open (~790–798 px Arabic, ~852–864 px English;
 * docs/fonts.md 2c).
 */

const VIEWPORTS = [
  { width: 412, height: 823 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1350, height: 940 },
];

/** The banner's box and its copy's box, in CSS px. */
const boxes = (page: Page) =>
  page.evaluate(() => {
    const box = (selector: string) => {
      const r = document.querySelector(selector)!.getBoundingClientRect();
      return [r.width, r.height].map((v) => Math.round(v * 10) / 10);
    };
    return { banner: box('#consent-banner'), copy: box('#consent-banner .consent-text') };
  });

/** Whether the web-font faces the copy paints in are loaded (the stack's first family). */
const copyFaceLoaded = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('#consent-banner .consent-text')!;
    const s = getComputedStyle(el);
    const primary = s.fontFamily.split(',')[0]?.trim() ?? '';
    return document.fonts.check(`${s.fontWeight} ${s.fontSize} ${primary}`, el.textContent ?? '');
  });

for (const path of ['/ar/portfolio/all', '/portfolio/all']) {
  for (const viewport of VIEWPORTS) {
    test(`the banner's box is final from its first paint — ${path} @ ${viewport.width}`, async ({
      browser,
    }) => {
      // In the fallback: every web font refused, so the copy stays in it.
      const fallback = await browser.newContext({ viewport });
      const a = await fallback.newPage();
      await a.route('**/fonts/*.woff2', (route) => route.abort());
      await a.goto(path, { waitUntil: 'load' });
      await expect(a.locator('#consent-banner')).toBeVisible();
      expect(await copyFaceLoaded(a), 'precondition: the copy is in the fallback').toBe(false);
      const before = await boxes(a);
      await fallback.close();

      // In its own fonts.
      const loaded = await browser.newContext({ viewport });
      const b = await loaded.newPage();
      await b.goto(path, { waitUntil: 'load' });
      await b.evaluate(() => document.fonts.ready);
      await expect(b.locator('#consent-banner')).toBeVisible();
      expect(await copyFaceLoaded(b), 'precondition: the copy is in its own face').toBe(true);
      const after = await boxes(b);
      await loaded.close();

      // Within a pixel: `3lh` resolves on a rounded line height (69 px for three 23.04 px lines),
      // and Chromium counts no movement under 3 px as a layout shift. A re-wrap is 23 px.
      for (const key of ['banner', 'copy'] as const) {
        for (const [i, dim] of (['width', 'height'] as const).entries()) {
          expect(
            Math.abs(after[key][i]! - before[key][i]!),
            `the ${key} ${dim} changed when its fonts arrived: ${before[key][i]} → ${after[key][i]}`,
          ).toBeLessThan(1);
        }
      }
    });
  }
}

test('the banner shows at once, before any web font, at every width (#26)', async ({ browser }) => {
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await page.route('**/fonts/*.woff2', () => {}); // held, never answered
    await page.goto('/ar/portfolio/all', { waitUntil: 'domcontentloaded' });
    // Read once, no waiting: its script is a module, run before DOMContentLoaded, so a reveal
    // held back by any amount — even a sub-second font wait — reads hidden here.
    expect(
      await page.evaluate(() => !document.getElementById('consent-banner')!.hidden),
      `shown at DOMContentLoaded @ ${viewport.width}`,
    ).toBe(true);
    await context.close();
  }
});
