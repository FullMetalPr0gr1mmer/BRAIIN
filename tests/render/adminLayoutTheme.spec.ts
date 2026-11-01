import { describe, expect, test } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import AdminLayout from '@/layouts/AdminLayout.astro';
import { IDENTITY } from './fixtures';
import { normalise } from './harness';

// The admin wears the site's theme (Admin v2 E4, ui.md "Theme": `--ad-primary:
// var(--bs-klein, #0024BC)`): AdminLayout links the same stylesheet the site links, after
// admin.css and the screen's own sheets, only while a theme sets a token; with none it
// renders exactly as before. Rendered without a session (the bare shell), which is all the
// head needs.

// The address names the hash of the body (getActiveTheme's); a visitor never reads the
// row's version (CR6).
const THEME = {
  tokens: { '--bs-klein': '#000000' },
  css: ':root{--bs-klein:#000000;}',
  hash: 'fedcba9876543210',
};
const LINK = '<link rel="stylesheet" href="/styles/theme.css?v=fedcba9876543210">';

async function render(theme: unknown): Promise<string> {
  const container = await AstroContainer.create();
  const html = await container.renderToString(AdminLayout, {
    props: { title: 'Theme', styles: ['theme.css'] },
    slots: { default: '<p>Screen</p>' },
    request: new Request('https://admin.example.test/admin/appearance/theme'),
    locals: {
      session: null,
      csrfToken: 'token',
      identity: Promise.resolve(IDENTITY),
      ...(theme === undefined ? {} : { theme: Promise.resolve({ theme, failed: false }) }),
    } as Partial<App.Locals> as App.Locals,
  });
  return normalise(html);
}

describe('AdminLayout and the theme', () => {
  test('no theme: no link, the page as it was', async () => {
    const without = await render(undefined);
    expect(await render(null)).toBe(without);
    expect(without).not.toContain('/styles/theme.css');
  });

  test('a theme: one link, after admin.css and the screen’s sheet, and nothing else', async () => {
    const without = await render(null);
    const themed = await render(THEME);
    expect(themed.split(LINK)).toHaveLength(2);
    expect(themed.replace(LINK, '')).toBe(without);
    const head = themed.slice(0, themed.indexOf('</head>'));
    const sheets = [...head.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
    expect(sheets).toEqual([
      '/styles/admin.css',
      '/styles/admin/theme.css',
      '/styles/theme.css?v=fedcba9876543210',
    ]);
  });
});
