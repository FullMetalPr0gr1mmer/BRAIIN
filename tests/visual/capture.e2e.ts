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
const DIR = process.env.CAPTURE_DIR;

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
          await context.close();
        });
      }
    }
  }
});
