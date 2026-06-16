import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// WCAG 2.2 AA DOM audit (CLAUDE.md DoD #4 — "axe zero violations on themed output").
// Covers both locales incl. an /ar/ RTL route. The token-level contrast guard
// (scripts/contrast-audit.mjs) runs in main CI; this DOM pass runs in the staged
// perf-seo-a11y workflow against a served build (needs a browser).
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

for (const route of ROUTES) {
  test(`axe: no WCAG A/AA violations on ${route}`, async ({ page }) => {
    await page.goto(route, { waitUntil: 'networkidle' });
    const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
}
