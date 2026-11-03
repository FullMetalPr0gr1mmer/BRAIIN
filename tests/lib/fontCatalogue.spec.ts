import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileTheme, DEFAULT_THEME_SETTINGS, themeCss } from '@theme/compile';
import {
  ARABIC_FAMILY_IDS,
  DEFAULT_FONTS,
  FONT_FAMILIES,
  FONT_TOKENS,
  LATIN_FAMILY_IDS,
  STACK_CHARS,
  brandFamily,
  familyForTokens,
  familyIds,
  fontTokenPattern,
  fontTokenRules,
  fontTokens,
  type FontFamily,
} from '@theme/fonts';
import {
  FONT_FACES,
  chosenFontFaces,
  familyFaceRules,
  fontFaceCss,
  heroFile,
  matchWeight,
  type FamilyFaces,
} from '@theme/fontFaces';
import { themeStylesheet } from '@theme/stylesheet';
import { ThemeSettingsSchema } from '@schemas/theme';
import { THEME_TOKEN_PATTERNS, ThemeTokensSchema, tokenMax } from '@schemas/themeTokens';
import { HERO_WEIGHTS, heroFontPreload, themedHeroWeight } from '@/lib/seo/fonts';
import { catalogueProblems, ROUTE_BUDGET, type CatalogueInput } from './fontCatalogueRules';

// The font catalogue (Admin v2 E13; README "a curated self-hosted font catalogue"; CLAUDE.md
// §6; docs/fonts.md "The catalogue"). The mechanism is whole while owner item O-21 keeps the
// catalogue at the brand's two families: the faces global.css and admin.css declare ARE the
// catalogue's, every rule a family must pass is checked over it, and a family built here for the
// test (never shipped) proves the choice reaches the tokens, theme.css, the faces and the
// preload. With the brand's families only, every page is exactly what it was: no font token
// can be written, and the stylesheet and the preload are E12's.

const GLOBAL = readFileSync('public/styles/global.css', 'utf8');
const ADMIN = readFileSync('public/styles/admin.css', 'utf8');
const PUBLIC_SHEETS = ['global', 'about', 'work', 'banner', 'case-study', 'services', 'join'].map(
  (name) => readFileSync(`public/styles/${name}.css`, 'utf8'),
);

/** A stylesheet's `@font-face` rules, whitespace collapsed (as adminStyles.spec.ts reads them). */
const fontFaces = (css: string) =>
  [...css.matchAll(/@font-face\s*\{[^}]*\}/g)].map((m) => m[0].replace(/\s+/g, ' ').trim());

/** A custom property's value in a stylesheet, whitespace collapsed. */
const stackOf = (css: string, name: string) =>
  new RegExp(`${name}:\\s*([^;]+);`).exec(css)?.[1]?.replace(/\s+/g, ' ').trim();

const sizeOf = (file: string) => {
  try {
    return statSync(`public${file}`).size;
  } catch {
    return null;
  }
};

/** The weights the public stylesheets paint text at: every literal, every token's fallback,
 *  normal (400) and bold (700, a heading's or a <b>'s default). */
const SITE_WEIGHTS = [
  ...new Set([
    400,
    700,
    ...PUBLIC_SHEETS.flatMap((css) =>
      [
        ...css
          .replace(/@font-face\s*\{[^}]*\}/g, '')
          .matchAll(/font-weight:\s*(?:var\([^,]+,\s*)?(\d{3})/g),
      ].map((m) => Number(m[1])),
    ),
  ]),
].sort((a, b) => a - b);

const REAL: CatalogueInput = {
  families: FONT_FAMILIES,
  faces: FONT_FACES,
  sizeOf,
  siteWeights: SITE_WEIGHTS,
};

// ---- A family for the test only (never in the catalogue): a static Latin family ---------------
const TEST_SANS: FontFamily = {
  id: 'test-sans',
  name: 'Test Sans',
  script: 'latin',
  brand: false,
  licence: { name: 'SIL Open Font License 1.1', notice: 'Copyright the test' },
  stack: "'Test Sans', 'Test Sans Fallback', system-ui, sans-serif",
};
const fallback = (weight: number, local: readonly string[]) => ({
  family: 'Test Sans Fallback',
  weight,
  subset: 'latin' as const,
  local,
  sizeAdjust: '100%',
  ascentOverride: '90%',
  descentOverride: '22%',
  lineGapOverride: '0%',
});
const TEST_SANS_FACES: FamilyFaces = {
  web: [400, 700, 800].map((weight) => ({
    weight,
    subset: 'latin' as const,
    file: `/fonts/test-sans-${weight}-latin.woff2` as const,
    unicodeRange: 'U+0020-007E',
  })),
  fallbacks: [400, 700, 800].map((w) =>
    fallback(w, w >= 600 ? ['Arial Bold', 'Liberation Sans Bold'] : ['Arial', 'Liberation Sans']),
  ),
};
const WITH_TEST: CatalogueInput = {
  ...REAL,
  families: [...FONT_FAMILIES, TEST_SANS],
  faces: { ...FONT_FACES, 'test-sans': TEST_SANS_FACES },
  sizeOf: (file) => (file.startsWith('/fonts/test-sans-') ? 20_000 : sizeOf(file)),
};

describe('the catalogue: closed, code-owned, the brand’s two families until O-21', () => {
  it('holds Archivo for English and Almarai for Arabic, each the brand’s', () => {
    // Owner item O-21 (the families, with their web licences) is open: a family joins with
    // its files, its measured fallbacks and a migration, and this list moves with it.
    expect(FONT_FAMILIES.map((f) => `${f.id}:${f.script}:${f.brand}`)).toEqual([
      'archivo:latin:true',
      'almarai:arabic:true',
    ]);
    expect(DEFAULT_FONTS).toEqual({
      latin: brandFamily('latin').id,
      arabic: brandFamily('arabic').id,
    });
    expect(LATIN_FAMILY_IDS).toEqual(familyIds('latin'));
    expect(ARABIC_FAMILY_IDS).toEqual(familyIds('arabic'));
    expect(LATIN_FAMILY_IDS[0]).toBe('archivo');
    expect(ARABIC_FAMILY_IDS[0]).toBe('almarai');
  });

  it('every family passes every rule: files, swap, fallbacks per weight, script and platform, budgets', () => {
    expect(SITE_WEIGHTS).toEqual([400, 500, 600, 700, 800]);
    expect(catalogueProblems(REAL)).toEqual([]);
    expect(catalogueProblems(WITH_TEST)).toEqual([]);
  });

  it('records each family’s licence and the notice its files carry', () => {
    for (const family of FONT_FAMILIES) {
      expect(family.licence.name, family.id).toBe('SIL Open Font License 1.1');
      expect(family.licence.notice, family.id).toMatch(/^Copyright /);
    }
  });

  it('every web face is `font-display: swap` and loads from /fonts/ (same origin)', () => {
    for (const family of FONT_FAMILIES) {
      const css = fontFaceCss(familyFaceRules(family), 'spaced');
      for (const face of css.filter((r) => r.includes('url('))) {
        expect(face, family.id).toContain('font-display: swap;');
        expect(face, family.id).toMatch(
          /src: url\('\/fonts\/[a-z0-9-]+\.woff2'\) format\('woff2'\);/,
        );
      }
      for (const face of css.filter((r) => !r.includes('url('))) {
        expect(face, family.id).toMatch(/src: (local\('[^']+'\)(, )?)+;/);
      }
    }
  });
});

describe('the rules catch a family that breaks them (a family built to break each)', () => {
  const broken = (family: Partial<FontFamily>, faces: Partial<FamilyFaces>, sizes = 20_000) => {
    const f = { ...TEST_SANS, ...family };
    return catalogueProblems({
      ...REAL,
      families: [...FONT_FAMILIES, f],
      faces: { ...FONT_FACES, [f.id]: { ...TEST_SANS_FACES, ...faces } },
      sizeOf: (file) => (file.startsWith('/fonts/test-sans-') ? sizes : sizeOf(file)),
    });
  };
  const has = (problems: string[], pattern: RegExp) =>
    expect(
      problems.some((p) => pattern.test(p)),
      problems.join('\n'),
    ).toBe(true);

  it('a file that is missing, or not under /fonts/', () => {
    has(
      catalogueProblems({
        ...WITH_TEST,
        sizeOf: (f) => (f.startsWith('/fonts/test-sans-') ? null : sizeOf(f)),
      }),
      /test-sans: \/fonts\/test-sans-400-latin\.woff2 does not exist/,
    );
    has(
      broken(
        {},
        {
          web: [
            { ...TEST_SANS_FACES.web[0]!, file: '/fonts/../x.woff2' as `/fonts/${string}.woff2` },
          ],
        },
      ),
      /is not under \/fonts\//,
    );
  });

  it('a hero file over 35 KB (Latin) or 45 KB (Arabic), and a route over 180 KB', () => {
    has(
      broken({}, {}, 36 * 1024),
      /the hero file \/fonts\/test-sans-800-latin\.woff2 is 36864 B, over 35840/,
    );
    has(broken({}, {}, 62 * 1024), /test-sans: a route set in it loads 190464 B, over 184320/);
    // An Arabic route counts its family and every family its stack names (Almarai's: Archivo).
    const heavy = (kb: number) =>
      catalogueProblems({
        ...REAL,
        sizeOf: (f) => (f.startsWith('/fonts/almarai-') ? kb * 1024 : sizeOf(f)),
      });
    has(heavy(46), /the hero file \/fonts\/almarai-800-arabic\.woff2 is 47104 B, over 46080/);
    has(heavy(25), /almarai: a route set in it loads 188528 B, over 184320/);
    expect(heavy(24)).toEqual([]);
    expect(ROUTE_BUDGET).toBe(184_320);
  });

  it('a heading weight that would be synthetic bold', () => {
    const only400 = TEST_SANS_FACES.web.filter((f) => f.weight === 400);
    has(broken({}, { web: only400 }), /test-sans: no real 800 face/);
  });

  it('a weight with no fallback, or one on a single platform', () => {
    has(
      broken({}, { fallbacks: TEST_SANS_FACES.fallbacks.filter((f) => f.weight !== 700) }),
      /no Arial fallback at 700 for latin/,
    );
    has(
      broken({}, { fallbacks: TEST_SANS_FACES.fallbacks.map((f) => ({ ...f, local: ['Arial'] })) }),
      /no Linux fallback at 400 for latin/,
    );
    has(
      broken(
        {},
        { fallbacks: TEST_SANS_FACES.fallbacks.map((f) => ({ ...f, local: ['Liberation Sans'] })) },
      ),
      /no Arial fallback at 800 for latin/,
    );
  });

  it('an Arabic family without its Latin subset, its Arabic-range fallbacks or a Linux Arabic face', () => {
    const almarai = FONT_FACES.almarai;
    const arabic = (faces: Partial<FamilyFaces>) =>
      catalogueProblems({ ...REAL, faces: { ...FONT_FACES, almarai: { ...almarai, ...faces } } });
    has(
      arabic({ web: almarai.web.filter((f) => f.subset === 'arabic') }),
      /almarai: an Arabic family has no Latin subset/,
    );
    has(
      arabic({
        fallbacks: almarai.fallbacks.filter((f) => !(f.subset === 'arabic' && f.weight === 800)),
      }),
      /almarai: no Arial fallback at 800 for arabic/,
    );
    has(
      arabic({
        fallbacks: almarai.fallbacks.map((f) =>
          f.subset === 'arabic' && f.local[0]?.startsWith('DejaVu')
            ? { ...f, local: ['Liberation Sans'] }
            : f,
        ),
      }),
      /names Liberation Sans, which has no Arabic/,
    );
  });

  it('a stack that does not name the family and its fallbacks first', () => {
    has(
      broken({ stack: "'Test Sans', system-ui, sans-serif" }, {}),
      /does not name its fallback families/,
    );
    has(
      broken({ stack: "'Other', 'Test Sans Fallback', sans-serif" }, {}),
      /does not start with Test Sans/,
    );
  });

  it('a static family whose fallback resolves a site weight elsewhere than its web faces', () => {
    has(
      broken(
        {},
        { fallbacks: [...TEST_SANS_FACES.fallbacks, fallback(500, ['Arial', 'Liberation Sans'])] },
      ),
      /500 renders at 400 but its fallback at 500/,
    );
  });

  it('two brand families for a script, or none', () => {
    has(
      catalogueProblems({
        ...WITH_TEST,
        families: [...FONT_FAMILIES, { ...TEST_SANS, brand: true }],
      }),
      /latin: 2 brand families/,
    );
  });
});

describe('the faces global.css and admin.css declare are the catalogue’s', () => {
  it('global.css: the brand’s families, block for block, in order', () => {
    const brand = FONT_FAMILIES.filter((f) => f.brand);
    expect(fontFaces(GLOBAL)).toEqual(
      brand.flatMap((f) => fontFaceCss(familyFaceRules(f), 'spaced')),
    );
  });

  it('admin.css: every family of the catalogue, so the editor draws each in itself', () => {
    expect(fontFaces(ADMIN)).toEqual(
      FONT_FAMILIES.flatMap((f) => fontFaceCss(familyFaceRules(f), 'spaced')),
    );
  });

  it('the stacks the stylesheets hold are the brand families’ (what no token means)', () => {
    expect(stackOf(GLOBAL, '--bs-font-sans')).toBe(brandFamily('latin').stack);
    expect(stackOf(GLOBAL, '--bs-font-ar')).toBe(brandFamily('arabic').stack);
    expect(stackOf(ADMIN, '--ad-font')).toBe(brandFamily('latin').stack);
    expect(stackOf(ADMIN, '--ad-font-ar')).toBe(brandFamily('arabic').stack);
  });

  it('the public stylesheets name no family but through the two stacks', () => {
    // A rule that named a family itself would not follow the theme, and would load its files on
    // top of the chosen family's (the route budget counts the page's family only).
    for (const css of PUBLIC_SHEETS) {
      const rules = css.replace(/@font-face\s*\{[^}]*\}/g, '');
      for (const m of rules.matchAll(/font-family:\s*([^;]+);/g)) {
        expect(['var(--bs-font-sans)', 'var(--bs-font-ar)', 'inherit']).toContain(m[1]!.trim());
      }
      expect(rules).not.toMatch(/(^|[^-])font:\s*[^;]*\b(Archivo|Almarai)\b/);
    }
  });
});

describe('the two font tokens', () => {
  it('each takes exactly the stacks of its script’s non-brand families: today, nothing', () => {
    expect(THEME_TOKEN_PATTERNS['--bs-font-sans'].source).toBe(fontTokenPattern('latin').source);
    expect(THEME_TOKEN_PATTERNS['--bs-font-ar'].source).toBe(fontTokenPattern('arabic').source);
    for (const name of ['--bs-font-sans', '--bs-font-ar'] as const) {
      for (const value of [
        brandFamily('latin').stack,
        brandFamily('arabic').stack,
        'serif',
        '',
        "'Test Sans', 'Test Sans Fallback', system-ui, sans-serif",
      ]) {
        expect(ThemeTokensSchema.safeParse({ [name]: value }).success, `${name} ${value}`).toBe(
          false,
        );
      }
    }
  });

  it('with a non-brand family, its stack and nothing else (the mechanism, on a test family)', () => {
    const families = [...FONT_FAMILIES, TEST_SANS];
    const pattern = fontTokenPattern('latin', families);
    expect(pattern.test(TEST_SANS.stack)).toBe(true);
    for (const value of [
      brandFamily('latin').stack,
      `${TEST_SANS.stack} `,
      `${TEST_SANS.stack};x`,
      'serif',
    ]) {
      expect(pattern.test(value), value).toBe(false);
    }
    expect(fontTokenPattern('arabic', families).source).toBe('^(?!)');
    expect(fontTokens({ latin: 'test-sans', arabic: 'almarai' }, families)).toEqual({
      '--bs-font-sans': TEST_SANS.stack,
    });
    expect(fontTokens(DEFAULT_FONTS, families)).toEqual({});
    expect(fontTokenRules(families)).toContainEqual({
      key: 'latin',
      choice: 'test-sans',
      token: '--bs-font-sans',
      value: TEST_SANS.stack,
    });
  });

  it('a family’s stack fits its token, and holds nothing a pattern or a declaration reads', () => {
    for (const family of [...FONT_FAMILIES, TEST_SANS]) {
      expect(STACK_CHARS.test(family.stack), family.id).toBe(true);
      expect(family.stack.length, family.id).toBeLessThanOrEqual(
        tokenMax(FONT_TOKENS[family.script]),
      );
      expect((family.stack.match(/'/g) ?? []).length % 2, family.id).toBe(0);
    }
  });

  it('a stack with a character outside the set cannot become a pattern', () => {
    expect(() =>
      fontTokenPattern('latin', [...FONT_FAMILIES, { ...TEST_SANS, stack: "'X'; color: red" }]),
    ).toThrow(/a stack outside/);
  });
});

describe('the settings choose a family per script (v3)', () => {
  it('the brand’s fonts compile to no token, so a theme compiles as it did before E13', () => {
    expect(compileTheme(DEFAULT_THEME_SETTINGS)).toEqual({});
    expect(DEFAULT_THEME_SETTINGS.fonts).toEqual(DEFAULT_FONTS);
  });

  it('a family off the catalogue, or of the other script, is refused', () => {
    for (const fonts of [
      { latin: 'inter', arabic: 'almarai' },
      { latin: 'archivo', arabic: 'archivo' },
      { latin: 'almarai', arabic: 'almarai' },
      { latin: 'archivo' },
      { latin: 'archivo', arabic: 'almarai', heading: 'archivo' },
    ]) {
      expect(ThemeSettingsSchema.safeParse({ ...DEFAULT_THEME_SETTINGS, fonts }).success).toBe(
        false,
      );
    }
  });
});

describe('theme.css follows the choice', () => {
  const THEMED = compileTheme({
    ...DEFAULT_THEME_SETTINGS,
    colors: { primary: '#000000', hover: '#615757', accent: '#938A8D' },
    shapes: { corners: 'soft', buttons: 'square' },
  });

  it('the brand’s fonts add nothing: the body is E12’s `:root` rule, byte for byte', () => {
    expect(chosenFontFaces(THEMED)).toBe('');
    expect(themeStylesheet(THEMED)).toBe(themeCss(THEMED));
    expect(themeStylesheet(THEMED)).toMatch(/^:root\{[^{}]*\}$/);
    expect(themeStylesheet({})).toBe('');
    expect(themeStylesheet(null)).toBe('');
  });

  it('a token that is not a catalogue family’s stack writes no face and no stylesheet', () => {
    expect(themeStylesheet({ ...THEMED, '--bs-font-sans': "'Evil', serif" })).toBe('');
    expect(themeStylesheet({ '--bs-font-ar': brandFamily('arabic').stack })).toBe('');
  });

  it('a non-brand family’s faces come first, from the catalogue (the mechanism, on a test family)', () => {
    const tokens = { ...THEMED, '--bs-font-sans': TEST_SANS.stack };
    const faces = chosenFontFaces(tokens, [...FONT_FAMILIES, TEST_SANS], {
      ...FONT_FACES,
      'test-sans': TEST_SANS_FACES,
    });
    expect(faces).toBe(
      fontFaceCss(familyFaceRules(TEST_SANS, TEST_SANS_FACES), 'compact').join(''),
    );
    expect(faces.match(/@font-face\{/g)).toHaveLength(6);
    expect(faces).toContain(
      "font-family:'Test Sans';font-style:normal;font-weight:800;font-display:swap;src:url('/fonts/test-sans-800-latin.woff2') format('woff2')",
    );
    expect(faces).toContain(
      "font-family:'Test Sans Fallback';font-weight:700;src:local('Arial Bold'), local('Liberation Sans Bold')",
    );
    expect(faces).not.toMatch(/Archivo|Almarai/);
  });
});

describe('the one preload follows the choice', () => {
  it('the brand’s: the hrefs every route preloads today', () => {
    expect(heroFontPreload('en')).toBe('/fonts/archivo-var-latin.woff2');
    expect(heroFontPreload('en', 600)).toBe('/fonts/archivo-var-latin.woff2');
    expect(heroFontPreload('ar')).toBe('/fonts/almarai-800-arabic.woff2');
    expect(heroFontPreload('ar', 600)).toBe('/fonts/almarai-700-arabic.woff2');
    expect(heroFontPreload('ar', 700)).toBe('/fonts/almarai-700-arabic.woff2');
    expect(heroFontPreload('ar', themedHeroWeight(800, '700'))).toBe(
      '/fonts/almarai-700-arabic.woff2',
    );
    expect(heroFontPreload('ar', 800, { '--bs-font-ar': 'unknown' })).toBe(
      '/fonts/almarai-800-arabic.woff2',
    );
    expect(HERO_WEIGHTS).toEqual([600, 700, 800]);
  });

  it('a chosen family’s file at the heading’s weight (the mechanism, on a test family)', () => {
    const families = [...FONT_FAMILIES, TEST_SANS];
    const family = familyForTokens('latin', { '--bs-font-sans': TEST_SANS.stack }, families);
    expect(family.id).toBe('test-sans');
    expect(heroFile(family, 800, TEST_SANS_FACES)).toBe('/fonts/test-sans-800-latin.woff2');
    expect(heroFile(family, 600, TEST_SANS_FACES)).toBe('/fonts/test-sans-700-latin.woff2');
    expect(familyForTokens('latin', {}, families).id).toBe('archivo');
    expect(familyForTokens('arabic', { '--bs-font-sans': TEST_SANS.stack }, families).id).toBe(
      'almarai',
    );
  });

  it('weights resolve as the browser resolves them (CSS Fonts 4 §5.2)', () => {
    const almarai = [400, 700, 800];
    expect(matchWeight(600, almarai)).toBe(700);
    expect(matchWeight(500, almarai)).toBe(400);
    expect(matchWeight(450, [400, 500, 800])).toBe(500);
    expect(matchWeight(300, almarai)).toBe(400);
    expect(matchWeight(900, almarai)).toBe(800);
    expect(matchWeight(800, [[400, 800]])).toBe(800);
    expect(matchWeight(900, [[400, 800]])).toBe(800);
  });
});
