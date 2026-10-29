import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/*
 * The AdminCollection island at phone and desktop widths (Admin v2 U7, brief 8.1), shared by
 * tests/admin/faq.e2e.ts and tests/admin/collections.e2e.ts: the per-role sweep runs at
 * Desktop Chrome's 1280 only, and the island's list and drawer have their own narrow rules
 * (collection.css wraps a row's actions at 640px and below).
 */

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
export const COLLECTION_VIEWPORTS = [320, 390, 1280];

/**
 * At each width: zero axe WCAG 2.2 A/AA violations, and no sideways scroll on the page or in
 * an open drawer's body. Leaves the page at 1280.
 */
export async function expectCleanAtWidths(page: Page, label: string) {
  for (const width of COLLECTION_VIEWPORTS) {
    await page.setViewportSize({ width, height: 900 });
    const sideways = await page.evaluate(() => {
      const root = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      const bodies = [...document.querySelectorAll('dialog[open] .drw__b')]
        .map((body) => body.scrollWidth - body.clientWidth)
        .concat([0]);
      return Math.max(root, ...bodies);
    });
    expect(sideways, `${label} at ${width}px: no sideways scroll`).toBeLessThanOrEqual(0);
    const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(
      violations.map(
        (v) =>
          `${v.id} [${v.impact ?? 'n/a'}] ${v.nodes.length}x: ${v.help} at ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
      ),
      `${label} at ${width}px`,
    ).toEqual([]);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}
