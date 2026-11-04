import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '@playwright/test';

// Design-parity capture (UI v2 round 2 acceptance), not an assertion suite.
//
// It runs only when CAPTURE_DIR is set. The perf-seo-a11y e2e job sets it after the real
// suites and uploads the directory as a build artifact. The screenshots show the seeded
// placeholders on the built Worker, so the page-by-page comparison with the design mockups
// can happen before any production data changes.
//
// It is also the seed of the PR14 visual-regression suite.
//
// Since Admin v2 E12 (AV-32) each page is captured a second time THEMED (`<name>-themed.png`):
// square corners and buttons, Bold headings as written, set the way the editor previews them
// (the four custom properties on <html> through the CSSOM), so the side-by-side comparison shows
// what a theme's shapes and type reach in both languages. tests/visual/theme.e2e.ts asserts it.
const DIR = process.env.CAPTURE_DIR;

const THEMED: Record<string, string> = {
  '--bs-radius-scale': '0',
  '--bs-btn-radius': '0px',
  '--bs-heading-weight': '700',
  '--bs-heading-case': 'none',
};

const ROUTES = [
  '/',
  '/services',
  '/services#events',
  '/services/logo',
  '/services/music-vo-sfx',
  '/services/booth-production',
  '/portfolio',
  '/portfolio/the-rider',
  '/contact',
] as const;
const VIEWPORTS = [
  { tag: 'd', width: 1366, height: 900 },
  { tag: 'm', width: 412, height: 915 },
] as const;

test.describe('design capture', () => {
  test.skip(!DIR, 'CAPTURE_DIR not set');
  test.describe.configure({ mode: 'parallel' });

  for (const vp of VIEWPORTS) {
    for (const route of ROUTES) {
      for (const locale of ['en', 'ar'] as const) {
        const path = locale === 'ar' ? (route === '/' ? '/ar' : `/ar${route}`) : route;
        const name = `${locale}-${vp.tag}-${route.replace(/[/#]+/g, '_').replace(/^_|_$/g, '') || 'home'}`;
        test(name, async ({ browser }) => {
          const context = await browser.newContext({
            viewport: { width: vp.width, height: vp.height },
            reducedMotion: 'reduce',
            isMobile: vp.tag === 'm',
            hasTouch: vp.tag === 'm',
          });
          const page = await context.newPage();
          await page.goto(path, { waitUntil: 'load' });
          await page.evaluate(() => document.fonts.ready);
          // Walk the page so lazy images and in-view reveals settle, then return to the top.
          await page.evaluate(async () => {
            const h = document.documentElement.scrollHeight;
            for (let y = 0; y < h; y += 400) {
              window.scrollTo(0, y);
              await new Promise((r) => setTimeout(r, 50));
            }
            window.scrollTo(0, 0);
          });
          await page.waitForTimeout(600);
          mkdirSync(DIR!, { recursive: true });
          await page.screenshot({ path: join(DIR!, `${name}.png`), fullPage: true });
          // The page's words beside its picture, so the comparison with the design can diff
          // the copy (verbatim EN + AR is a Round 2 requirement) and not only the pixels.
          const text = await page.evaluate(() => ({
            title: document.title,
            lang: document.documentElement.lang,
            dir: document.documentElement.dir,
            hs: [...document.querySelectorAll('h1,h2,h3')].map(
              (h) => `${h.tagName} ${(h.textContent ?? '').replace(/\s+/g, ' ').trim()}`,
            ),
            body: document.body.innerText,
          }));
          writeFileSync(join(DIR!, `${name}.json`), JSON.stringify(text, null, 1));
          // The themed twin: the same page, the tokens set, two frames for the style to settle.
          await page.evaluate(async (tokens) => {
            for (const [k, v] of Object.entries(tokens)) {
              document.documentElement.style.setProperty(k, v);
            }
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          }, THEMED);
          await page.screenshot({ path: join(DIR!, `${name}-themed.png`), fullPage: true });
          await context.close();
        });
      }
    }
  }
});

// Admin v2 E9: the section appearance variants, each a picture of the seeded custom page's Text
// block (`how-we-work`, both languages, a desktop and a phone width) with the attribute set on it
// the way the renderer writes it, plain and under the themed tokens. tests/visual/
// sectionAppearance.e2e.ts asserts what these show (the grounds, the contrast, axe, the spacing).
const LOOKS: readonly (readonly [string, Record<string, string>])[] = [
  ['own', {}],
  ['bg-mist', { 'data-bg': 'mist' }],
  ['bg-ink', { 'data-bg': 'ink' }],
  ['bg-klein', { 'data-bg': 'klein' }],
  ['space-compact', { 'data-space': 'compact' }],
  ['space-roomy', { 'data-space': 'roomy' }],
];

test.describe('design capture, section appearance', () => {
  test.skip(!DIR, 'CAPTURE_DIR not set');
  test.describe.configure({ mode: 'parallel' });

  for (const vp of VIEWPORTS) {
    for (const locale of ['en', 'ar'] as const) {
      const path = locale === 'ar' ? '/ar/how-we-work' : '/how-we-work';
      test(`${locale}-${vp.tag}-e9-looks`, async ({ browser }) => {
        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          reducedMotion: 'reduce',
          isMobile: vp.tag === 'm',
          hasTouch: vp.tag === 'm',
        });
        const page = await context.newPage();
        await page.goto(path, { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready);
        const block = page.locator('section.blk-text');
        mkdirSync(DIR!, { recursive: true });
        for (const themed of [false, true]) {
          for (const [look, attrs] of LOOKS) {
            await page.evaluate(
              async ({ attrs, tokens }) => {
                const el = document.querySelector('section.blk-text')!;
                for (const name of ['data-bg', 'data-space']) el.removeAttribute(name);
                for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
                for (const [k, v] of Object.entries(tokens)) {
                  document.documentElement.style.setProperty(k, v);
                }
                await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
              },
              { attrs, tokens: themed ? THEMED : {} },
            );
            const name = `${locale}-${vp.tag}-e9-${look}${themed ? '-themed' : ''}.png`;
            await block.screenshot({ path: join(DIR!, name) });
          }
        }
        await context.close();
      });
    }
  }
});
