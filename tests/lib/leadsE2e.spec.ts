import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The leads end-to-end spec's own rules (Admin v2 C4b), read from its source: Playwright
// runs it only in CI, against the local stack, so a race it carries shows up there as a
// flaky failure a retry hides. These keep the two that make it deterministic.

const SPEC = 'tests/admin/leads.e2e.ts';
const source = readFileSync(SPEC, 'utf8').replace(/\r\n/g, '\n');

/** The body of `test.describe('as admin', …)`, up to the next top-level statement. */
function adminDescribe(): string {
  const start = source.indexOf("test.describe('as admin'");
  expect(start, 'the admin describe').toBeGreaterThan(-1);
  const end = source.indexOf('\n});\n', start);
  return source.slice(start, end);
}

describe('tests/admin/leads.e2e.ts', () => {
  it('runs the admin tests one at a time (the round trip reads a shared count)', () => {
    // The round trip reads the sidebar's New-leads count before and after; the other admin
    // tests move and erase New leads. fullyParallel would schedule them side by side.
    expect(adminDescribe()).toContain("test.describe.configure({ mode: 'serial' });");
  });

  it('waits for the islands after every page it opens', () => {
    // The leads pages are server-rendered first (C4b): their controls are on screen before
    // React listens. Every navigation goes through open(), which waits for hydration; the
    // one bare goto is csrf()'s, which only fetches the cookie and acts on nothing.
    const from = source.indexOf('async function open(');
    expect(from, 'the open() helper').toBeGreaterThan(-1);
    const helper = source.slice(from, source.indexOf('\n}\n', from));
    expect(helper).toContain(
      "page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null)",
    );
    const gotos = source
      .split('\n')
      .filter((line) => line.includes('.goto('))
      .map((line) => line.trim());
    expect(gotos).toEqual([
      "if (!(await find())) await page.goto('/admin', { waitUntil: 'domcontentloaded' });",
      'const res = await page.goto(path, options);',
    ]);
    expect(source.match(/await open\(page, /g)?.length ?? 0).toBeGreaterThanOrEqual(8);
  });
});
