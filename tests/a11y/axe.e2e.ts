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
  '/portfolio',
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
