import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

// `:has()` is NOT a forgiving selector: an engine without it (Firefox < 121, Safari < 15.4,
// Chromium < 105) treats a selector list that contains it as invalid and drops the WHOLE
// rule, including the selectors in it that need no `:has()`. The /services explorer once
// kept its script-driven `.is-live` panel hiding in one list with a `:has()` selector, so
// such an engine showed all five panels at once whatever the script set (Round 2 S3 review).
// Rule: a selector list is either all `:has()` or has none.

const DIR = join(process.cwd(), 'public', 'styles');

/**
 * Selector lists that mix the two and predate the rule (global.css, the intro cut, UI v2).
 * In such an engine the intro-cut shortcut drops with the `:focus-visible` one. Deferred to
 * their owner; listed by their first selector so a new mixed list still fails.
 */
const KNOWN: Record<string, readonly string[]> = {
  'global.css': ['body.intro-cut .intro', 'body.intro-cut .letter'],
};

/** Every style rule's selector list, comments and strings removed, split at top-level commas. */
function selectorLists(css: string): string[][] {
  const text = css
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
  const lists: string[][] = [];
  // The `{` is a lookahead, so it can also open the next match (a rule inside @media).
  const re = /(?:^|[{};])\s*([^{};]+?)\s*(?=\{)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const prelude = m[1]!;
    if (prelude.startsWith('@')) continue;
    const parts: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of prelude) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        parts.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    parts.push(cur.trim());
    lists.push(parts.map((p) => p.replace(/\s+/g, ' ')));
  }
  return lists;
}

const mixed = (list: readonly string[]) => {
  const n = list.filter((s) => s.includes(':has(')).length;
  return n > 0 && n < list.length;
};

describe('selectorLists', () => {
  it('splits at top-level commas only, and skips at-rule preludes', () => {
    const css = `@media (min-width: 1px) { .a, .b:is(.c, .d) { x: y } }
      .e:has(.f, .g) { content: '{,}' }`;
    expect(selectorLists(css)).toEqual([['.a', '.b:is(.c, .d)'], ['.e:has(.f, .g)']]);
  });

  it('flags a list that mixes `:has()` with selectors that do not need it', () => {
    expect(mixed(['.a:has(.b)', '.c'])).toBe(true);
    expect(mixed(['.a:has(.b)', '.c:has(.d)'])).toBe(false);
    expect(mixed(['.a', '.c'])).toBe(false);
  });
});

describe('the served stylesheets', () => {
  // Every sheet under public/styles, the admin's screen sheets (admin/) included.
  const sheets = readdirSync(DIR, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.css'))
    .map((f) => f.split(sep).join('/'));

  it('exist', () => {
    expect(sheets).toContain('services.css');
  });

  for (const sheet of sheets) {
    it(`${sheet}: no selector list mixes :has() with selectors that do not need it`, () => {
      const known = KNOWN[sheet] ?? [];
      const offenders = selectorLists(readFileSync(join(DIR, sheet), 'utf8'))
        .filter(mixed)
        .filter((list) => !known.includes(list[0]!));
      expect(offenders).toEqual([]);
    });
  }

  it('the explorer keeps its script-driven hiding in a list with no :has()', () => {
    const lists = selectorLists(readFileSync(join(DIR, 'services.css'), 'utf8'));
    const live = lists.find((l) => l.includes('.svc-xp.is-live .svc-panel:not(.is-active)'));
    expect(live).toEqual([
      '.svc-xp:not(.is-live) .svc-panel:not(:target)',
      '.svc-xp.is-live:not(.is-open)',
      '.svc-xp.is-live .svc-panel:not(.is-active)',
    ]);
  });
});
