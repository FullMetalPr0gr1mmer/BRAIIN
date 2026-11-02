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
// stack; and the run must keep every budget of the main one, with one exception: on the two
// image-LCP routes, LCP and the performance score warn (E4-C1, below).

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
      '<link rel="stylesheet" href="/styles/global.css"><link rel="stylesheet" href="/styles/theme.css?v=0123456789abcdef">';
    expect(themeLinks(html)).toEqual(['/styles/theme.css?v=0123456789abcdef']);
    expect(themeLinks('<link rel="stylesheet" href="/styles/admin/theme.css">')).toEqual([]);
    // The address names the body's hash, never a row's version (E4-SEC-1).
    expect(themeLinks('<link rel="stylesheet" href="/styles/theme.css?v=12">')).toEqual([]);
  });
});

describe('the run', () => {
  const main = JSON.parse(readFileSync('lighthouserc.json', 'utf8'));
  const themed = JSON.parse(readFileSync('lighthouserc.themed.json', 'utf8'));

  type Matrix = {
    matchingUrlPattern: string;
    aggregationMethod: string;
    assertions: Record<string, unknown>;
  }[];
  const matrix = (themed.ci.assert.assertMatrix ?? []) as Matrix;
  const groupOf = (url: string) => matrix.filter((m) => new RegExp(m.matchingUrlPattern).test(url));
  // The image-LCP routes (/ and /ar: the intro logo). Over wrangler dev's cleartext HTTP/1.1
  // the extra render-blocking stylesheet costs about 75 ms of simulated LCP that HTTP/2 and 3
  // never pay (as-built E4, "LCP, CLS and the extra stylesheet"), so these two budgets warn
  // there; everything a theme can break (axe on the themed colours, CLS, TBT, SEO, fonts,
  // images) stays an error (E4 review, E4-C1).
  const WARN_ON_IMAGE_LCP = ['categories:performance', 'largest-contentful-paint'];

  it('keeps every budget of the main run, on routes the main run measures', () => {
    expect(Object.keys(themed.ci.assert)).toEqual(['assertMatrix']);
    expect(themed.ci.collect.numberOfRuns).toBe(main.ci.collect.numberOfRuns);
    expect(themed.ci.collect.url).toHaveLength(4);
    for (const url of themed.ci.collect.url) expect(main.ci.collect.url).toContain(url);
    expect(matrix).toHaveLength(2);
    for (const entry of matrix) {
      expect(entry.aggregationMethod).toBe(main.ci.assert.aggregationMethod);
      expect(Object.keys(entry.assertions).sort()).toEqual(
        Object.keys(main.ci.assert.assertions).sort(),
      );
    }
  });

  it('each route is in one group; text LCP keeps every budget an error, image LCP warns on two', () => {
    for (const url of themed.ci.collect.url as string[]) {
      // Lighthouse matches the final URL: a trailing slash after a redirect is the same route.
      for (const u of [url, url.endsWith('/') ? url : `${url}/`])
        expect(groupOf(u), u).toHaveLength(1);
    }
    const [image] = groupOf('http://localhost:8788/');
    expect(groupOf('http://localhost:8788/ar')[0]).toBe(image);
    const [text] = groupOf('http://localhost:8788/services/logo');
    expect(groupOf('http://localhost:8788/contact')[0]).toBe(text);
    expect(text).not.toBe(image);
    expect(text!.assertions).toEqual(main.ci.assert.assertions);
    for (const [key, value] of Object.entries(main.ci.assert.assertions)) {
      const mine = image!.assertions[key];
      if (WARN_ON_IMAGE_LCP.includes(key)) {
        const [level, options] = value as [string, unknown];
        expect(level).toBe('error');
        expect(mine, key).toEqual(['warn', options]);
      } else {
        expect(mine, key).toEqual(value);
      }
    }
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
