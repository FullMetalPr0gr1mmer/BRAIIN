import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { compileTheme, hasTokens } from '@theme/compile';
import { gate } from '@theme/gate';
import { ThemeSettingsSchema } from '@schemas/theme';
import { ThemeTokensSchema } from '@schemas/themeTokens';
import fixture from '../fixtures/themedRun.json';
import { isLoopback, themeLinks, themedRunRow } from '../../scripts/lhci-theme.mjs';

// The themed Lighthouse run (Admin v2 E4; README "Gates that stay green: lhci (+ a themed
// run)"): perf-seo-a11y.yml's lighthouse job saves tests/fixtures/themedRun.json as the active
// theme (scripts/lhci-theme.mjs) and measures four routes again with the same budgets
// (lighthouserc.themed.json). The fixture must be a theme the gate and the database accept, or
// the run would measure nothing themed; the script must never write anywhere but the job's own
// stack; and the run must keep every budget of the main one.

describe('the theme the run sets', () => {
  it('is a valid v1 theme that passes the gate, its tokens the compiler’s', () => {
    const settings = ThemeSettingsSchema.parse(fixture.settings);
    expect(gate(settings.colors).ok).toBe(true);
    expect(fixture.tokens).toEqual(compileTheme(settings));
    expect(ThemeTokensSchema.safeParse(fixture.tokens).success).toBe(true);
    expect(hasTokens(fixture.tokens)).toBe(true);
    // Every kind of token: colours, glows, shadows and both motion settings.
    expect(Object.keys(fixture.tokens)).toHaveLength(11);
    expect(themedRunRow()).toEqual({
      name: 'Lighthouse themed run',
      settings: fixture.settings,
      tokens: fixture.tokens,
      is_active: true,
    });
  });
});

describe('scripts/lhci-theme.mjs', () => {
  it('writes to a loopback stack only', () => {
    for (const url of ['http://127.0.0.1:54321', 'http://localhost:8788', 'http://[::1]:54321/']) {
      expect(isLoopback(url), url).toBe(true);
    }
    for (const url of [
      'https://127.0.0.1:54321',
      'https://abcd.supabase.co',
      'http://127.0.0.1.example.test',
      'http://localhost:8788/rest',
      'http://10.0.0.1:54321',
      '',
      undefined,
    ]) {
      expect(isLoopback(url), String(url)).toBe(false);
    }
  });

  it('finds the theme links a page carries', () => {
    const html =
      '<link rel="stylesheet" href="/styles/global.css"><link rel="stylesheet" href="/styles/theme.css?v=12">';
    expect(themeLinks(html)).toEqual(['/styles/theme.css?v=12']);
    expect(themeLinks('<link rel="stylesheet" href="/styles/admin/theme.css">')).toEqual([]);
  });
});

describe('the run', () => {
  const main = JSON.parse(readFileSync('lighthouserc.json', 'utf8'));
  const themed = JSON.parse(readFileSync('lighthouserc.themed.json', 'utf8'));

  it('keeps every budget of the main run, on routes the main run measures', () => {
    expect(themed.ci.assert).toEqual(main.ci.assert);
    expect(themed.ci.collect.numberOfRuns).toBe(main.ci.collect.numberOfRuns);
    expect(themed.ci.collect.url).toHaveLength(4);
    for (const url of themed.ci.collect.url) expect(main.ci.collect.url).toContain(url);
  });

  it('runs last in the lighthouse job: the theme, then the themed budgets', () => {
    const workflow = parse(readFileSync('.github/workflows/perf-seo-a11y.yml', 'utf8')) as {
      jobs: { lighthouse: { steps: { name?: string; run?: string }[] } };
    };
    const runs = workflow.jobs.lighthouse.steps.map((s) => s.run ?? '');
    const at = (cmd: string) => runs.findIndex((r) => r.trim() === cmd);
    expect(at('npm run lhci')).toBeGreaterThan(-1);
    expect(at('npm run lhci:desktop')).toBeGreaterThan(at('npm run lhci'));
    expect(at('node scripts/lhci-theme.mjs')).toBeGreaterThan(at('npm run lhci:desktop'));
    expect(at('npm run lhci:themed')).toBe(at('node scripts/lhci-theme.mjs') + 1);
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['lhci:themed']).toBe('lhci autorun --config=lighthouserc.themed.json');
  });
});
