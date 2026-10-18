import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The two step end-to-end spec's own rules (Admin v2 U17), read from its source: Playwright
// runs it only in CI, against the local stack, so what it fails to check is invisible here and
// a timeout it carries shows up there as a flaky failure a retry repeats.

const SPEC = 'tests/admin/twoStep.e2e.ts';
const source = readFileSync(SPEC, 'utf8').replace(/\r\n/g, '\n');

/** A TOTP step (GoTrue's 30 s) plus the half second freshCode() adds. */
const STEP_WAIT_MS = 30_500;
/** What a test does besides waiting: sign-ins, three widths of axe, a reset, the log. */
const WORK_MS = 60_000;

describe('tests/admin/twoStep.e2e.ts', () => {
  it('gives each test room for a full TOTP step on top of its work', () => {
    // freshCode() can wait up to a whole step for a code GoTrue has not seen; Playwright's
    // default (30 s) would end the test inside that wait, and the CI retry has the same odds.
    expect(source).toContain('await page.waitForTimeout(untilNextStep() + 500);');
    const configure = source.match(/test\.describe\.configure\(\{([^}]*)\}\);/);
    expect(configure, 'the serial configure').not.toBeNull();
    expect(configure![1]).toContain("mode: 'serial'");
    const timeout = configure![1]!.match(/timeout:\s*([\d_]+)/);
    expect(timeout, 'a timeout on the serial group').not.toBeNull();
    expect(Number(timeout![1]!.replace(/_/g, ''))).toBeGreaterThanOrEqual(STEP_WAIT_MS + WORK_MS);
    expect(source).not.toMatch(/test\.setTimeout\(/);
  });
});
