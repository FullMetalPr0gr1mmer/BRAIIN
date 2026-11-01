import { describe, expect, test } from 'vitest';
import { themeCss } from '@theme/compile';
import { LAYOUT_CASES, renderLayout } from './layout';

// The public layout and the site's theme (Admin v2 E4, AV-27). Its twin, baseLayout.spec.ts,
// holds the layout with no theme to the byte as it stood before E4 (that snapshot is
// unchanged): a site with no theme row, or one reset to the brand's own, serves the page it
// always did. This proves what an active theme adds: exactly one same-origin stylesheet link,
// in the head, after the page's own stylesheets so its custom properties win, and nothing else
// anywhere. A preview draws the PENDING theme instead, as the same custom properties in one
// nonced <style> (a Tier C admin response), and never links the live one.

const TOKENS = {
  '--bs-klein': '#000000',
  '--bs-cobalt': '#615757',
  '--bs-sky': '#938a8d',
  '--bs-sky-soft': '#c3bdbf',
  '--bs-glow-klein': 'rgba(0, 0, 0, 0.42)',
  '--bs-glow-sky': 'rgba(147, 138, 141, 0.45)',
  '--bs-shadow-klein': '0 12px 38px rgba(0, 0, 0, 0.45)',
  '--bs-shadow-cobalt': '0 18px 48px rgba(97, 87, 87, 0.45)',
};
// The address names the hash of the body (getActiveTheme's), never the row's version.
const THEME = { tokens: TOKENS, version: 7, css: themeCss(TOKENS), hash: '0123456789abcdef' };
const LINK = '<link rel="stylesheet" href="/styles/theme.css?v=0123456789abcdef">';

const cases = Object.keys(LAYOUT_CASES) as (keyof typeof LAYOUT_CASES)[];

describe('the theme in the public layout', () => {
  test.each(cases)('%s: one link with a theme, the page unchanged without one', async (name) => {
    const props = { ...LAYOUT_CASES[name] };
    const without = await renderLayout(props);
    const none = await renderLayout(props, { theme: Promise.resolve(null) });
    const themed = await renderLayout(props, { theme: Promise.resolve(THEME) });
    expect(none).toBe(without);
    expect(themed.split(LINK)).toHaveLength(2);
    expect(themed.replace(LINK, '')).toBe(without);
    // In the head, after every other stylesheet (the theme's custom properties win).
    const head = themed.slice(0, themed.indexOf('</head>'));
    expect(head).toContain(LINK);
    const sheets = [...head.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
    expect(sheets.at(-1)).toBe('/styles/theme.css?v=0123456789abcdef');
    expect(themed).not.toMatch(/<style\b/);
  });

  test('after a page’s own route stylesheets too', async () => {
    const props = { ...LAYOUT_CASES['about, English, overlay header'], styles: ['about.css'] };
    const html = await renderLayout(props, { theme: Promise.resolve(THEME) });
    const head = html.slice(0, html.indexOf('</head>'));
    const sheets = [...head.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
    expect(sheets).toEqual([
      '/styles/global.css',
      '/styles/about.css',
      '/styles/theme.css?v=0123456789abcdef',
    ]);
  });

  test('a preview draws the pending theme in one nonced <style>, and links no stylesheet', async () => {
    const preview = { locale: 'en', path: '/admin/preview' } as never;
    const html = await renderLayout(
      { ...LAYOUT_CASES['home, English'] },
      { theme: Promise.resolve(THEME), preview, cspNonce: 'n0nce' },
    );
    expect(html).not.toContain('/styles/theme.css');
    const styles = [...html.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/g)];
    expect(styles).toHaveLength(1);
    expect(styles[0]![1]).toContain('nonce="n0nce"');
    expect(styles[0]![2]).toBe(themeCss(TOKENS));
    expect(html.indexOf('<style')).toBeLessThan(html.indexOf('</head>'));
  });

  test('a preview with no pending or live theme carries no style', async () => {
    const preview = { locale: 'en', path: '/admin/preview' } as never;
    const html = await renderLayout(
      { ...LAYOUT_CASES['home, English'] },
      { theme: Promise.resolve(null), preview, cspNonce: 'n0nce' },
    );
    expect(html).not.toMatch(/<style\b/);
    expect(html).not.toContain('/styles/theme.css');
  });
});
