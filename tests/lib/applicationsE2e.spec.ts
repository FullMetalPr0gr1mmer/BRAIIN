import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The job applications end-to-end spec's own rules (Admin v2 U8a), read from its source:
// Playwright runs it only in CI, against the local stack, so a press that never lands shows up
// there as a timeout the CI retry repeats, and a check it skips is invisible here.

const SPEC = 'tests/admin/applications.e2e.ts';
const source = readFileSync(SPEC, 'utf8').replace(/\r\n/g, '\n');

/** The body of `async function <name>(`, up to its closing brace at the start of a line. */
function functionBody(name: string): string {
  const from = source.indexOf(`async function ${name}(`);
  expect(from, `the ${name}() helper`).toBeGreaterThan(-1);
  return source.slice(from, source.indexOf('\n}\n', from));
}

describe('tests/admin/applications.e2e.ts', () => {
  it('presses a row’s Open the keyboard’s way, never with a click', () => {
    // admin.css (F4b): where the device hovers, `.dt .row-acts` takes no pointer press until its
    // row is hovered or focused. The mouse rests on the drawer's Close or the confirm's Erase,
    // so `.click()` waits for a button that never turns clickable (both tests timed out in CI,
    // the retry too). Focus arms the row at once.
    const helper = functionBody('pressRowAction');
    expect(helper).toContain('await button.focus();');
    expect(helper).toContain("await button.press('Enter');");
    // One place names the row action, so no other locator can reach it with a click.
    expect(source.match(/’s application`/g)).toHaveLength(1);
    expect(source).toContain("page.getByRole('button', { name: `Open ${name}’s application` });");
    expect(source).not.toMatch(/openButton\([^)]*\)\s*\.(click|dblclick|tap)\(/);
    // Every press of it goes through the helper: the slow-save test and the erase test.
    const presses = source.match(/await pressRowAction\(openButton\(page, OTHER\)\);/g) ?? [];
    expect(presses).toHaveLength(2);
    const uses = source.match(/openButton\(page, \w+\)/g) ?? [];
    const asserted = source.match(/expect\(openButton\(page, \w+\)\)/g) ?? [];
    expect(uses.length).toBe(presses.length + asserted.length);
  });
});
