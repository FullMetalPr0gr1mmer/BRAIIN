import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// WCAG 2.2 AA DOM audit (CLAUDE.md DoD #4 — "axe zero violations on themed output").
// Covers both locales incl. an /ar/ RTL route. The token-level contrast guard
// (scripts/contrast-audit.mjs) runs in main CI; this DOM pass runs in the perf-seo-a11y
// workflow against a served build with seeded data (needs a browser).
const ROUTES = [
  '/',
  '/ar',
  '/services',
  '/ar/services',
  // Round 2 (S3): the explorer OPEN (a deep link opens its panel at first paint) — the APG
  // tabs, a tabpanel, the service rows and their Inquire pills
  '/services#events',
  '/ar/services#events',
  '/portfolio',
  // UI v2 PR10
  '/ar/portfolio',
  '/portfolio/all',
  '/ar/portfolio/all',
  // UI v2 PR11 — a seeded case study (every part: quote, breakdown, gallery, next)
  '/portfolio/the-rider',
  '/ar/portfolio/the-rider',
  // Round 2 (S4) — a seeded service page (hero crumb + skip pill, the case block, the form)
  '/services/logo',
  '/ar/services/logo',
  '/about',
  '/ar/about',
  '/contact',
  '/ar/contact',
  '/search',
];

// WCAG 2.0/2.1/2.2 level A + AA rule tags.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

// Audited under prefers-reduced-motion. Reveal-on-scroll content sits at opacity 0 until it
// enters the viewport, and axe treats opacity 0 as hidden — so a normal-motion run SKIPPED
// every below-the-fold block, and one caught mid-fade read as ~1:1 contrast (a flake, not a
// finding). Reduced motion renders every element in its final state (global.css), so the
// whole page is checked, deterministically. Motion itself is covered by the hero/intro and
// reduced-motion e2e specs.
for (const route of ROUTES) {
  test(`axe: no WCAG A/AA violations on ${route}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(route, { waitUntil: 'networkidle' });
    const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
}

// Round 3 (R3-7): the header's motion switch is hidden under reduced motion (nothing to
// pause there), so the pass above never sees it. One normal-motion pass, scoped to the
// header — once its entrance has settled — audits the button (name, role, pressed state,
// contrast) in both directions, on a route with no intro plate.
for (const route of ['/contact', '/ar/contact']) {
  test(`axe: the header, normal motion, with the motion switch — ${route}`, async ({ page }) => {
    // `load`, not `networkidle`: with motion on, the contact hero's loop mounts after load
    // and its open range request never lets the network go idle (csp.e2e.ts records it).
    await page.goto(route, { waitUntil: 'load' });
    await expect
      .poll(() => page.locator('.site-header').evaluate((el) => getComputedStyle(el).opacity))
      .toBe('1');
    await expect(page.locator('[data-motion-toggle]')).toBeVisible();
    const { violations } = await new AxeBuilder({ page })
      .include('.site-header')
      .withTags(TAGS)
      .analyze();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
}
