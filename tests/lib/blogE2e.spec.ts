import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The post editor end-to-end spec's own rules (Admin v2 U8b), read from its source: Playwright
// runs it only in CI, and the file runs serially, so one locator that matches nothing skips
// every test after it, and a check that cannot fail passes unseen.

const SPEC = 'tests/admin/blog.e2e.ts';
const source = readFileSync(SPEC, 'utf8').replace(/\r\n/g, '\n');

describe('tests/admin/blog.e2e.ts', () => {
  it('finds a tab by its whole computed name, and the cleared cue by its words', () => {
    // A string is matched exactly, so "Content" is the tab without the cue and
    // "Content, has errors" the tab with it (TabStrip names it with aria-label).
    expect(source).toContain(
      ".getByRole('tab', typeof name === 'string' ? { name, exact: true } : { name });",
    );
    expect(source).toContain("await expect(tab(page, 'Content, has errors')).toBeVisible();");
    // The cleared check looks for the cue's words on any tab, so it fails while one remains.
    expect(source).toContain('await expect(tab(page, /has errors/)).toHaveCount(0);');
    expect(source).not.toMatch(/tab\(page, '[^']*has errors'\)\)\.toHaveCount\(0\)/);
  });
});
