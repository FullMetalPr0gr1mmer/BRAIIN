import { describe, expect, it, vi } from 'vitest';
import type { FamilyFaces } from '@theme/fontFaces';
import type { FontFamily } from '@theme/fonts';

// The whole chain a font choice takes (Admin v2 E13), on a family added for the test alone
// (owner item O-21 keeps the real catalogue at the brand's two): the settings choose it, the
// compiler writes its stack as the page's font token, the closed token set takes exactly that
// stack, and /styles/theme.css carries the family's faces ahead of the `:root` rule. The real
// catalogue, schema and stylesheet are used throughout; the mocks only add the family to the
// lists each reads (as a family that joins the catalogue would be added to each).

const { TEST_SANS, TEST_SANS_FACES } = vi.hoisted(() => {
  const family = {
    id: 'test-sans',
    name: 'Test Sans',
    script: 'latin' as const,
    brand: false,
    licence: { name: 'SIL Open Font License 1.1', notice: 'Copyright the test' },
    stack: "'Test Sans', 'Test Sans Fallback', system-ui, sans-serif",
  };
  const faces = {
    web: [400, 700].map((weight) => ({
      weight,
      subset: 'latin' as const,
      file: `/fonts/test-sans-${weight}-latin.woff2` as const,
      unicodeRange: 'U+0020-007E',
    })),
    fallbacks: [
      {
        family: 'Test Sans Fallback',
        weight: 700,
        subset: 'latin' as const,
        local: ['Arial Bold', 'Liberation Sans Bold'],
        sizeAdjust: '101%',
        ascentOverride: '90%',
        descentOverride: '22%',
        lineGapOverride: '0%',
      },
    ],
  };
  return { TEST_SANS: family as FontFamily, TEST_SANS_FACES: faces as FamilyFaces };
});

vi.mock('@theme/fonts', async (load) => {
  const real = await load<typeof import('@theme/fonts')>();
  const families = [...real.FONT_FAMILIES, TEST_SANS];
  return {
    ...real,
    FONT_FAMILIES: families,
    fontTokens: (fonts: Record<'latin' | 'arabic', string>) => real.fontTokens(fonts, families),
    familyForTokens: (script: 'latin' | 'arabic', tokens: Record<string, string>) =>
      real.familyForTokens(script, tokens, families),
  };
});
vi.mock('@theme/fontFaces', async (load) => {
  const real = await load<typeof import('@theme/fontFaces')>();
  const { FONT_FAMILIES } = await import('@theme/fonts');
  const faces = { ...real.FONT_FACES, 'test-sans': TEST_SANS_FACES };
  return {
    ...real,
    chosenFontFaces: (tokens: Record<string, string>) =>
      real.chosenFontFaces(tokens, FONT_FAMILIES, faces),
  };
});
vi.mock('@schemas/themeTokens', async (load) => {
  const real = await load<typeof import('@schemas/themeTokens')>();
  const { z } = await import('zod');
  const { FONT_FAMILIES, fontTokenPattern } = await import('@theme/fonts');
  const pattern = fontTokenPattern('latin', FONT_FAMILIES);
  return {
    ...real,
    THEME_TOKEN_PATTERNS: { ...real.THEME_TOKEN_PATTERNS, '--bs-font-sans': pattern },
    ThemeTokensSchema: real.ThemeTokensSchema.extend({
      '--bs-font-sans': z.string().max(160).regex(pattern).optional(),
    }),
  };
});

const { compileTheme, DEFAULT_THEME_SETTINGS, themeCss } = await import('@theme/compile');
const { themeStylesheet } = await import('@theme/stylesheet');
const { fontFaceCss, familyFaceRules } = await import('@theme/fontFaces');

const CHOSEN = {
  ...DEFAULT_THEME_SETTINGS,
  shapes: { corners: 'soft', buttons: 'pill' },
  fonts: { latin: 'test-sans', arabic: 'almarai' },
} as unknown as typeof DEFAULT_THEME_SETTINGS;

describe('a font choice, settings to stylesheet', () => {
  it('the compiler writes the family’s stack as the English pages’ token, last', () => {
    expect(compileTheme(CHOSEN)).toEqual({
      '--bs-radius-scale': '0.5',
      '--bs-font-sans': TEST_SANS.stack,
    });
    expect(themeCss(compileTheme(CHOSEN))).toBe(
      `:root{--bs-radius-scale:0.5;--bs-font-sans:${TEST_SANS.stack};}`,
    );
  });

  it('the stylesheet: the family’s faces, then the `:root` rule', () => {
    const tokens = compileTheme(CHOSEN);
    const faces = fontFaceCss(familyFaceRules(TEST_SANS, TEST_SANS_FACES), 'compact').join('');
    expect(themeStylesheet(tokens)).toBe(`${faces}${themeCss(tokens)}`);
    expect(themeStylesheet(tokens).match(/@font-face\{/g)).toHaveLength(3);
    expect(themeStylesheet(tokens)).toMatch(/^@font-face\{font-family:'Test Sans';/);
  });

  it('the brand’s fonts: no face, the `:root` rule alone, as before', () => {
    const tokens = compileTheme({ ...CHOSEN, fonts: { latin: 'archivo', arabic: 'almarai' } });
    expect(tokens).toEqual({ '--bs-radius-scale': '0.5' });
    expect(themeStylesheet(tokens)).toBe(themeCss(tokens));
  });
});
