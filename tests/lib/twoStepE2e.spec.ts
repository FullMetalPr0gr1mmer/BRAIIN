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

  it('expects the setup step’s 422 for a wrong code, and no other console error', () => {
    // twoStepFlow's confirm renders the setup step again with 422 (its key is never stored,
    // so it cannot redirect); Chromium logs that document as "Failed to load resource". The
    // first test asserts the status and accepts exactly that one line, by its path; the
    // second (whose wrong code redirects) still accepts none.
    const first = source.slice(
      source.indexOf("test('sets 2FA up from the account"),
      source.indexOf("test('signing in asks for the code"),
    );
    expect(first).toMatch(/expect\(refused\.status\(\)[^)]*\)\.toBe\(422\)/);
    expect(first).toContain('status of 422\\b.* \\(\\/admin\\/2fa\\)$/');
    expect(first).not.toContain("expect(errors, 'no console error').toEqual([]);");
    const second = source.slice(
      source.indexOf("test('signing in asks for the code"),
      source.indexOf("test('an Admin resets it"),
    );
    expect(second).toContain("expect(errors, 'no console error').toEqual([]);");
    // The path is what tells the expected 422 from any other.
    expect(source).toContain('message.location().url');
  });

  it('asks GoTrue itself to add or remove a factor with the password alone, and expects no', () => {
    // Both layers stand on GoTrue's AAL rule: the hook (0072) stamps the role whenever no
    // verified factor is required, so if an aal1 token could unenrol the factor (or enrol a
    // second one and verify it), a stolen password would pass both. The spec calls GoTrue's
    // own endpoints with the token minted before the code, while the factor is verified.
    const step = source.slice(
      source.indexOf("test('signing in asks for the code"),
      source.indexOf("test('an Admin resets it"),
    );
    expect(step).toContain('const aal1 = await accessTokenOf(context);');
    expect(step).toMatch(/gotrue\(context, 'POST', '\/factors', aal1,/);
    expect(step).toMatch(/gotrue\(context, 'DELETE', `\/factors\/\$\{factorId\}`, aal1\)/);
    expect(step.match(/\.toBe\('insufficient_aal'\)/g)?.length ?? 0).toBe(2);
    // And the factor is still there, the only one, verified (asked of the service role).
    const after = step.indexOf("gotrue(context, 'DELETE'");
    expect(step.indexOf('await factorsOfAccount()', after)).toBeGreaterThan(after);
    // Before the code: the refusals are checked ahead of the right code being typed.
    expect(step.indexOf("gotrue(context, 'DELETE'")).toBeLessThan(
      step.indexOf("getByRole('button', { name: 'Verify' })"),
    );
  });
});
