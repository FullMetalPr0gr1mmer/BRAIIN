import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { FontFamily } from '@theme/fonts';

// The Fonts card with a second family to choose (Admin v2 E13). Owner item O-21 keeps the real
// catalogue at the brand's family per script, where reading a saved choice and falling back to
// the brand's look the same; this adds a Latin family for the test alone (never shipped), so
// the editor's half is proven to keep a choice, offer it as a tile drawn in itself, and draw
// the site sample in it.

const { TEST_SANS } = vi.hoisted(() => ({
  TEST_SANS: {
    id: 'test-sans',
    name: 'Test Sans',
    script: 'latin' as const,
    brand: false,
    licence: { name: 'SIL Open Font License 1.1', notice: 'Copyright the test' },
    stack: "'Test Sans', 'Test Sans Fallback', system-ui, sans-serif",
  } as FontFamily,
}));

vi.mock('@theme/fonts', async (load) => {
  const real = await load<typeof import('@theme/fonts')>();
  const families = [...real.FONT_FAMILIES, TEST_SANS];
  return {
    ...real,
    FONT_FAMILIES: families,
    LATIN_FAMILY_IDS: [...real.LATIN_FAMILY_IDS, TEST_SANS.id],
    familiesOf: (script: 'latin' | 'arabic') => real.familiesOf(script, families),
  };
});

const { settingsOf, withFont, fontOptions, fontStack } =
  await import('@/components/admin/screens/theme/model');
const { default: FontTiles } = await import('@/components/admin/screens/theme/FontTiles');
const { default: SitePreview } = await import('@/components/admin/screens/theme/SitePreview');
const { DEFAULT_THEME_SETTINGS } = await import('@theme/compile');
const { paletteOf } = await import('@theme/gate');
const { DEFAULT_COLORS } = await import('@theme/palette');

const attr = (stack: string) => `font-family="${stack.replace(/'/g, '&#x27;')}"`;

describe('the Fonts card with a family to choose', () => {
  it('a saved choice is kept; a family of the other script, or none, is the brand’s', () => {
    const chosen = { ...DEFAULT_THEME_SETTINGS, fonts: { latin: 'test-sans', arabic: 'almarai' } };
    expect(settingsOf(chosen).fonts).toEqual({ latin: 'test-sans', arabic: 'almarai' });
    expect(settingsOf(JSON.stringify(chosen)).fonts.latin).toBe('test-sans');
    expect(
      settingsOf({ ...chosen, fonts: { latin: 'almarai', arabic: 'test-sans' } }).fonts,
    ).toEqual({ latin: 'archivo', arabic: 'almarai' });
  });

  it('choosing it, and back', () => {
    const next = withFont(DEFAULT_THEME_SETTINGS, 'latin', 'test-sans');
    expect(next.fonts).toEqual({ latin: 'test-sans', arabic: 'almarai' });
    expect(withFont(next, 'latin', 'archivo').fonts).toEqual(DEFAULT_THEME_SETTINGS.fonts);
    expect(withFont(next, 'arabic', 'test-sans')).toBe(next);
    expect(fontStack(next.fonts, 'latin')).toBe(TEST_SANS.stack);
  });

  it('a tile per family, the brand’s first, the chosen one checked, each drawn in itself', () => {
    expect(fontOptions('latin').map((o) => o.value)).toEqual(['archivo', 'test-sans']);
    const html = renderToStaticMarkup(
      createElement(FontTiles, {
        script: 'latin',
        label: 'English pages',
        value: 'test-sans',
        onChange: () => undefined,
      }),
    );
    const input = (id: string) =>
      new RegExp(`data-font="${id}"><input type="radio"([^>]*)/>`).exec(html)?.[1] ?? '';
    expect(input('archivo')).not.toContain('checked');
    expect(input('test-sans')).toContain('checked=""');
    expect(html).toContain(attr(TEST_SANS.stack));
    expect(html).toContain(
      '<b>Test Sans</b> <span class="admin-sub">SIL Open Font License 1.1</span>',
    );
  });

  it('the site sample draws its English lines in the chosen family', () => {
    const html = renderToStaticMarkup(
      createElement(SitePreview, {
        palette: paletteOf(DEFAULT_COLORS),
        fonts: { latin: 'test-sans', arabic: 'almarai' } as never,
      }),
    );
    expect(html).toContain('data-latin="test-sans"');
    expect(html).toContain(`<g ${attr(TEST_SANS.stack)}>`);
  });
});
