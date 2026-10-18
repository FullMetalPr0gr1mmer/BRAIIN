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
});
