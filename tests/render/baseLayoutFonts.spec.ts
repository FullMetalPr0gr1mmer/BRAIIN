import { describe, expect, test, vi } from 'vitest';
import type { FamilyFaces } from '@theme/fontFaces';
import type { FontFamily } from '@theme/fonts';
import type { LiveTheme, ThemeAnswer } from '@/lib/data/theme';
import { LAYOUT_CASES, renderLayout } from './layout';

// The one font preload in the public layout follows the theme's fonts (Admin v2 E13). The
// catalogue holds only the brand's families until owner item O-21, so this spec adds a family
// for the test alone (never shipped) to the catalogue the layout reads, and proves the page a
// theme choosing it would serve: the chosen family's file at the route's heading weight, and
// nothing else changed. Without a font token the page is the brand's, byte for byte
// (baseLayout.spec.ts's snapshot, unchanged by E13).

// The test family, hoisted with the mocks that add it (vi.mock runs before the imports).
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
    web: [400, 700, 800].map((weight) => ({
      weight,
      subset: 'latin' as const,
      file: `/fonts/test-sans-${weight}-latin.woff2` as const,
      unicodeRange: 'U+0020-007E',
    })),
    fallbacks: [],
  };
  return { TEST_SANS: family as FontFamily, TEST_SANS_FACES: faces as FamilyFaces };
});

vi.mock('@theme/fonts', async (load) => {
  const real = await load<typeof import('@theme/fonts')>();
  const families = [...real.FONT_FAMILIES, TEST_SANS];
  return {
    ...real,
    familyForTokens: (script: 'latin' | 'arabic', tokens: Record<string, string>) =>
      real.familyForTokens(script, tokens, families),
  };
});
vi.mock('@theme/fontFaces', async (load) => {
  const real = await load<typeof import('@theme/fontFaces')>();
  return {
    ...real,
    heroFile: (family: FontFamily, weight: number) =>
      real.heroFile(family, weight, family.id === 'test-sans' ? TEST_SANS_FACES : undefined),
  };
});

const answer = (theme: LiveTheme | null): Promise<ThemeAnswer> =>
  Promise.resolve({ theme, failed: false });
const themed = (tokens: Record<string, string>): LiveTheme =>
  ({ tokens, css: ':root{--bs-klein:#000000;}', hash: '0123456789abcdef' }) as LiveTheme;

/** The font preloads a page carries (the hrefs, in order). */
const preloads = (html: string) =>
  [...html.matchAll(/<link rel="preload" href="([^"]+)" as="font"/g)].map((m) => m[1]);

describe('the preload follows the theme’s fonts (E13)', () => {
  test('no font token: the brand’s faces, at the route’s weight', async () => {
    const en = await renderLayout({ ...LAYOUT_CASES['home, English'] });
    const ar = await renderLayout({ ...LAYOUT_CASES['home, Arabic'] });
    const about = await renderLayout({ ...LAYOUT_CASES['home, Arabic'], heroWeight: 600 });
    expect(preloads(en)).toEqual(['/fonts/archivo-var-latin.woff2']);
    expect(preloads(ar)).toEqual(['/fonts/almarai-800-arabic.woff2']);
    expect(preloads(about)).toEqual(['/fonts/almarai-700-arabic.woff2']);
  });

  test('a chosen family: its file at the heading’s weight, the Bold rule too, one preload', async () => {
    const tokens = { '--bs-font-sans': TEST_SANS.stack };
    const home = await renderLayout(
      { ...LAYOUT_CASES['home, English'] },
      { theme: answer(themed(tokens)) },
    );
    const about = await renderLayout(
      { ...LAYOUT_CASES['about, English, overlay header'], heroWeight: 600 },
      { theme: answer(themed(tokens)) },
    );
    const bold = await renderLayout(
      { ...LAYOUT_CASES['home, English'] },
      { theme: answer(themed({ ...tokens, '--bs-heading-weight': '700' })) },
    );
    expect(preloads(home)).toEqual(['/fonts/test-sans-800-latin.woff2']);
    // A static family draws About's 600 heading with its 700 face, as the browser picks it.
    expect(preloads(about)).toEqual(['/fonts/test-sans-700-latin.woff2']);
    expect(preloads(bold)).toEqual(['/fonts/test-sans-700-latin.woff2']);
    // The Arabic pages keep their own family: the Latin choice does not reach them.
    const ar = await renderLayout(
      { ...LAYOUT_CASES['home, Arabic'] },
      { theme: answer(themed(tokens)) },
    );
    expect(preloads(ar)).toEqual(['/fonts/almarai-800-arabic.woff2']);
  });

  test('a stack no family has is the brand’s (only the catalogue changes the preload)', async () => {
    const html = await renderLayout(
      { ...LAYOUT_CASES['home, English'] },
      { theme: answer(themed({ '--bs-font-sans': "'Evil', serif" })) },
    );
    expect(preloads(html)).toEqual(['/fonts/archivo-var-latin.woff2']);
  });
});
