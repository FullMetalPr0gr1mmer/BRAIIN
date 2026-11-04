import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { INTRO_COLUMNS, SiteAppearanceWriteSchema } from '@schemas/appearance';
import { introFromRow } from '@/lib/appearance/intro';
import {
  INTRO_AS_BUILT,
  INTRO_STYLES,
  expectedPlate,
  introRunColumns,
  plateOf,
} from '../../scripts/lhci-intro.mjs';

// The loading screen's Lighthouse re-gate (Admin v2 E7; README's E7 row: "lhci re-gate"):
// perf-seo-a11y.yml's lighthouse job sets each style on its local stack (scripts/lhci-intro.mjs)
// and measures `/` and `/ar` again with the main run's budgets (lighthouserc.intro.json). The
// looks must be ones the schema and the CHECKs take, every style must be measured, the budgets
// must be the main run's (no warn: the plate adds no request), and the intro must be put back
// before the themed run. The plate each style serves is held to Hero's rendering in
// tests/render/introOptions.spec.ts.

const byKey = (columns: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(INTRO_COLUMNS).map(([key, column]) => [key, columns[column]] as const),
  );

describe('the looks the run sets', () => {
  it('measures every style the screen offers, with the bar, a tagline and the longest timing', () => {
    expect(INTRO_STYLES).toEqual(['video', 'black', 'light']);
    for (const style of INTRO_STYLES) {
      const columns = introRunColumns(style);
      // A save the schema takes, read back exactly (the reader drops nothing).
      expect(
        SiteAppearanceWriteSchema.safeParse({ ...byKey(columns), version: 0 }).success,
        style,
      ).toBe(true);
      expect(introFromRow(columns)).toEqual({
        backdrop: style,
        bar: true,
        tagline: columns['intro_tagline'],
        holdMs: 1500,
        fadeMs: 600,
      });
    }
    expect(() => introRunColumns('none')).toThrow();
  });

  it('reset is the intro as built', () => {
    expect(introRunColumns('reset')).toEqual(INTRO_AS_BUILT);
    expect(introFromRow(INTRO_AS_BUILT)).toEqual(introFromRow(null));
    expect(Object.keys(INTRO_AS_BUILT)).toEqual(Object.values(INTRO_COLUMNS));
  });

  it('reads the plate a page serves', () => {
    expect(plateOf('<main><div class="intro" aria-hidden="true" data-hold="1500">x')).toBe(
      '<div class="intro" aria-hidden="true" data-hold="1500">',
    );
    expect(plateOf('<div class="intro__tag">')).toBe('');
    expect(plateOf(undefined)).toBe('');
    expect(expectedPlate('reset')).toBe('<div class="intro" aria-hidden="true">');
    expect(expectedPlate('video')).not.toContain('data-backdrop');
  });
});

describe('the run', () => {
  const main = JSON.parse(readFileSync('lighthouserc.json', 'utf8'));
  const intro = JSON.parse(readFileSync('lighthouserc.intro.json', 'utf8'));

  it('measures the two pages with the plate, with every budget of the main run', () => {
    expect(intro.ci.collect.url).toEqual(['http://localhost:8788/', 'http://localhost:8788/ar']);
    for (const url of intro.ci.collect.url) expect(main.ci.collect.url).toContain(url);
    expect(intro.ci.collect.numberOfRuns).toBe(main.ci.collect.numberOfRuns);
    expect(intro.ci.assert).toEqual(main.ci.assert);
  });

  it('runs each style, then resets, after the desktop run and before the theme', () => {
    const workflow = parse(readFileSync('.github/workflows/perf-seo-a11y.yml', 'utf8')) as {
      jobs: { lighthouse: { steps: { name?: string; run?: string }[] } };
    };
    const runs = workflow.jobs.lighthouse.steps.map((s) => (s.run ?? '').trim());
    const at = (cmd: string) => runs.indexOf(cmd);
    const desktop = at('npm run lhci:desktop');
    expect(desktop).toBeGreaterThan(-1);
    let last = desktop;
    for (const style of INTRO_STYLES) {
      const set = at(`node scripts/lhci-intro.mjs ${style}`);
      expect(set, style).toBeGreaterThan(last);
      expect(runs[set + 1], style).toBe('npm run lhci:intro');
      last = set + 1;
    }
    const reset = at('node scripts/lhci-intro.mjs reset');
    expect(reset).toBe(last + 1);
    expect(at('node scripts/lhci-theme.mjs')).toBeGreaterThan(reset);
    expect(runs.filter((r) => r === 'npm run lhci:intro')).toHaveLength(INTRO_STYLES.length);
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['lhci:intro']).toBe('lhci autorun --config=lighthouserc.intro.json');
  });
});
