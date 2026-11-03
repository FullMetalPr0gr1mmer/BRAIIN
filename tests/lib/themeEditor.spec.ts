import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ThemeScreen, { THEME_FIELDS } from '@/components/admin/screens/theme/ThemeScreen';
import SitePreview from '@/components/admin/screens/theme/SitePreview';
import {
  ADMIN_PREVIEW_TOKENS,
  BUTTON_OPTIONS,
  CASE_OPTIONS,
  CORNER_OPTIONS,
  FONT_GROUPS,
  MARQUEE_OPTIONS,
  REVEAL_OPTIONS,
  WEIGHT_OPTIONS,
  derivedSettings,
  failureLines,
  gateView,
  settingsOf,
  fontOptions,
  fontStack,
  typedMain,
  validColors,
  withFont,
  withMain,
} from '@/components/admin/screens/theme/model';
import { formToPayload, rowToForm } from '@/lib/admin/formPayload';
import { DEFAULT_THEME_SETTINGS } from '@theme/compile';
import { FONT_FAMILIES, FONT_SAMPLE, brandFamily } from '@theme/fonts';
import { paletteOf, simplePalette, type GateResult } from '@theme/gate';
import { DEFAULT_COLORS } from '@theme/palette';
import {
  ThemeFontsSchema,
  ThemeMotionSchema,
  ThemeShapesSchema,
  ThemeTypeSchema,
} from '@schemas/theme';
import { THEME_TOKEN_NAMES } from '@schemas/themeTokens';

// The theme editor (/admin/appearance/theme, Admin v2 E4): its pure half (model.ts) and its
// server markup. The browser journey is tests/admin/theme.e2e.ts; this pins what it relies on
// (the accessible names it finds controls by) and what no browser run would notice (a saved
// theme read back into the form, the CSP's no-style rule).

vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

const SAVED = {
  v: 3,
  mode: 'advanced',
  colors: { primary: '#000000', hover: '#615757', accent: '#938A8D' },
  motion: { marquee: 'slowest', reveal: false },
  shapes: { corners: 'soft', buttons: 'square' },
  type: { headingWeight: 700, headingCase: 'as-written' },
  fonts: { latin: 'archivo', arabic: 'almarai' },
};
/** E4's shape: a theme saved before E12. */
const SAVED_V1 = { v: 1, mode: SAVED.mode, colors: SAVED.colors, motion: SAVED.motion };
/** E12's shape: a theme saved before E13. */
const SAVED_V2 = { ...SAVED_V1, v: 2, shapes: SAVED.shapes, type: SAVED.type };
const BRAND_SHAPES = { corners: 'brand', buttons: 'pill' };
const BRAND_TYPE = { headingWeight: 800, headingCase: 'uppercase' };
const BRAND_FONTS = { latin: 'archivo', arabic: 'almarai' };

describe('the form holds the settings the theme was saved with', () => {
  it('a saved theme, loaded through the field kit, is the theme the editor shows', () => {
    // rowToForm keeps a `json` field as text (JSON.stringify): the screen must read it back.
    const form = rowToForm(
      { id: 'x', name: 'Site theme', settings: SAVED, version: 3 },
      THEME_FIELDS,
    );
    expect(settingsOf(form['settings'])).toEqual(SAVED);
    // And what it sends is the object again, whichever way the form holds it.
    expect(formToPayload(form, THEME_FIELDS)['settings']).toEqual(SAVED);
    expect(formToPayload({ ...form, settings: SAVED }, THEME_FIELDS)['settings']).toEqual(SAVED);
  });

  it('a theme saved before E12 (v1) opens at the brand’s shapes, type and fonts, and saves as v3', () => {
    const form = rowToForm(
      { id: 'x', name: 'Site theme', settings: SAVED_V1, version: 3 },
      THEME_FIELDS,
    );
    expect(settingsOf(form['settings'])).toEqual({
      ...SAVED_V1,
      v: 3,
      shapes: BRAND_SHAPES,
      type: BRAND_TYPE,
      fonts: BRAND_FONTS,
    });
  });

  it('a theme saved before E13 (v2) opens at the brand’s fonts, and saves as v3', () => {
    const form = rowToForm(
      { id: 'x', name: 'Site theme', settings: SAVED_V2, version: 3 },
      THEME_FIELDS,
    );
    expect(settingsOf(form['settings'])).toEqual(SAVED);
  });

  it('anything else is the brand’s own settings, a fresh copy each time', () => {
    for (const value of [undefined, null, '', '{', '[]', 42, [], 'null']) {
      const settings = settingsOf(value);
      expect(settings, JSON.stringify(value)).toEqual(DEFAULT_THEME_SETTINGS);
      expect(settings).not.toBe(DEFAULT_THEME_SETTINGS);
      expect(settings.colors).not.toBe(DEFAULT_THEME_SETTINGS.colors);
    }
  });

  it('keeps a colour as typed, and drops a value of the wrong kind', () => {
    const settings = settingsOf({
      ...SAVED,
      colors: { primary: '#00', hover: 7, accent: '#938A8D' },
      motion: { marquee: 'faster', reveal: 'no' },
      shapes: { corners: 'huge', buttons: 999 },
      type: { headingWeight: 900, headingCase: 'lowercase' },
      fonts: { latin: 'inter', arabic: 'archivo' },
      extra: true,
    });
    expect(settings.colors).toEqual({ primary: '#00', hover: '#024CFF', accent: '#938A8D' });
    expect(settings.motion).toEqual({ marquee: 'normal', reveal: true });
    // A shape or type off its list is the brand's (the editor offers only the closed choices).
    expect(settings.shapes).toEqual(BRAND_SHAPES);
    expect(settings.type).toEqual(BRAND_TYPE);
    // A family off the catalogue, or of the other script, is the brand's.
    expect(settings.fonts).toEqual(BRAND_FONTS);
    expect(Object.keys(settings).sort()).toEqual([
      'colors',
      'fonts',
      'mode',
      'motion',
      'shapes',
      'type',
      'v',
    ]);
    // A string weight is not the number the schema stores.
    expect(settingsOf({ ...SAVED, type: { ...SAVED.type, headingWeight: '700' } }).type).toEqual({
      headingWeight: 800,
      headingCase: 'as-written',
    });
  });
});

describe('what the screen draws from the settings', () => {
  it('no gate and no palette while a colour is half typed', () => {
    const typing = { ...DEFAULT_THEME_SETTINGS, colors: { ...DEFAULT_COLORS, hover: '#7F' } };
    expect(validColors(typing.colors)).toBeNull();
    expect(gateView(typing)).toEqual({ result: null, palette: null });
    expect(gateView(DEFAULT_THEME_SETTINGS).result?.ok).toBe(true);
    expect(gateView(DEFAULT_THEME_SETTINGS).palette).toEqual(paletteOf(DEFAULT_COLORS));
  });

  it('Simple: a main colour makes the whole palette; a half-typed one waits', () => {
    expect(withMain(DEFAULT_THEME_SETTINGS, '#0b6eb0').colors).toEqual(simplePalette('#0B6EB0'));
    expect(withMain(DEFAULT_THEME_SETTINGS, '#0024BC').colors).toEqual(DEFAULT_COLORS);
    const typing = withMain({ ...DEFAULT_THEME_SETTINGS, colors: SAVED.colors }, '#0B');
    expect(typing.colors).toEqual({ ...SAVED.colors, primary: '#0B' });
  });

  it('Simple, as typed: the main colour goes in alone; the palette follows, deferred (CR3)', () => {
    const simple = { ...DEFAULT_THEME_SETTINGS, mode: 'simple' as const };
    const typed = typedMain(simple, '#0B6EB0');
    expect(typed.colors).toEqual({ ...DEFAULT_COLORS, primary: '#0B6EB0' });
    expect(typed.motion).toEqual(simple.motion);
    // The deferred render makes the palette from it, as choosing it did before.
    expect(derivedSettings(typed, true)).toEqual(withMain(simple, '#0B6EB0'));
    // Nothing typed, Advanced mode, a half-typed colour, or a palette already made from the
    // main colour: the same object (nothing written back, no second gate).
    expect(derivedSettings(typed, false)).toBe(typed);
    const advanced = { ...typed, mode: 'advanced' as const };
    expect(derivedSettings(advanced, true)).toBe(advanced);
    const half = typedMain(simple, '#0B');
    expect(derivedSettings(half, true)).toBe(half);
    const made = withMain(simple, '#0B6EB0');
    expect(derivedSettings(made, true)).toBe(made);
  });

  it('says each failure once', () => {
    const failure = (message: string) => ({ message }) as GateResult['failures'][number];
    const result = {
      ok: false,
      failures: [failure('A.'), failure('B.'), failure('A.')],
      suggestions: {},
    } as GateResult;
    expect(failureLines(result)).toEqual(['A.', 'B.']);
    expect(failureLines(null)).toEqual([]);
  });

  it('offers motion that only reduces, in the schema’s values', () => {
    const marquee = ThemeMotionSchema.shape.marquee.options;
    expect(MARQUEE_OPTIONS.map((o) => o.value)).toEqual(marquee);
    expect(MARQUEE_OPTIONS.map((o) => o.label)).toEqual(['Normal', 'Slower', 'Much slower']);
    expect(REVEAL_OPTIONS.map((o) => o.value)).toEqual(['on', 'off']);
  });

  it('offers the shapes and type the schema takes, every one, in words (E12)', () => {
    expect(CORNER_OPTIONS.map((o) => o.value)).toEqual(ThemeShapesSchema.shape.corners.options);
    expect(CORNER_OPTIONS.map((o) => o.label)).toEqual(['Brand', 'Square', 'Soft', 'Round']);
    expect(BUTTON_OPTIONS.map((o) => o.value)).toEqual(ThemeShapesSchema.shape.buttons.options);
    expect(BUTTON_OPTIONS.map((o) => o.label)).toEqual(['Pill', 'Rounded', 'Square']);
    expect(WEIGHT_OPTIONS.map((o) => Number(o.value))).toEqual(
      ThemeTypeSchema.shape.headingWeight.options.map((o) => o.value),
    );
    expect(WEIGHT_OPTIONS.map((o) => o.label)).toEqual(['Extra bold', 'Bold']);
    expect(CASE_OPTIONS.map((o) => o.value)).toEqual(ThemeTypeSchema.shape.headingCase.options);
    expect(CASE_OPTIONS.map((o) => o.label)).toEqual(['Capitals', 'As written']);
  });

  it('the Fonts card: a group per script, a tile per family of the catalogue (E13)', () => {
    expect(FONT_GROUPS.map((g) => [g.script, g.label])).toEqual([
      ['latin', 'English pages'],
      ['arabic', 'Arabic pages'],
    ]);
    for (const { script } of FONT_GROUPS) {
      expect(fontOptions(script).map((o) => o.value)).toEqual([
        ...ThemeFontsSchema.shape[script].options,
      ]);
      expect(fontOptions(script)[0]).toMatchObject({
        value: brandFamily(script).id,
        brand: true,
        sample: FONT_SAMPLE[script],
        stack: brandFamily(script).stack,
      });
    }
    // Choosing: only a family of that script.
    expect(withFont(DEFAULT_THEME_SETTINGS, 'latin', 'archivo')).toEqual(DEFAULT_THEME_SETTINGS);
    expect(withFont(DEFAULT_THEME_SETTINGS, 'latin', 'almarai')).toBe(DEFAULT_THEME_SETTINGS);
    expect(withFont(DEFAULT_THEME_SETTINGS, 'arabic', 'inter')).toBe(DEFAULT_THEME_SETTINGS);
    expect(fontStack(DEFAULT_THEME_SETTINGS.fonts, 'arabic')).toBe(brandFamily('arabic').stack);
  });

  it('previews the admin in the three tokens admin.css reads, and only those', () => {
    expect(Object.values(ADMIN_PREVIEW_TOKENS)).toEqual(['--bs-klein', '--bs-cobalt', '--bs-sky']);
    for (const name of Object.values(ADMIN_PREVIEW_TOKENS)) {
      expect(THEME_TOKEN_NAMES).toContain(name);
    }
  });
});

describe('the screen’s server markup', () => {
  const html = renderToStaticMarkup(createElement(ThemeScreen, { id: null, releaseMode: false }));

  it('the names the browser journey finds things by', () => {
    for (const name of [
      'Brand colours',
      'Shapes',
      'Typography',
      'Fonts',
      'Motion',
      'What stays the same',
      'Preview',
    ]) {
      expect(html, name).toMatch(new RegExp(`<h2 class="card__t" id="theme-[a-z]+">${name}</h2>`));
    }
    for (const legend of ['Corners', 'Buttons', 'Heading weight', 'Heading case']) {
      expect(html, legend).toContain(`<legend class="visually-hidden">${legend}</legend>`);
    }
    expect(html).toContain(
      '<legend class="visually-hidden">How do you want to set colours?</legend>',
    );
    expect(html).toContain('<legend class="visually-hidden">Clients marquee speed</legend>');
    expect(html).toContain('<legend class="visually-hidden">Sections</legend>');
    // The Fonts card (E13): a visible legend per script, a radio per family, chosen.
    for (const { label } of FONT_GROUPS) {
      expect(html, label).toContain(`<legend class="theme__label">${label}</legend>`);
    }
    for (const family of FONT_FAMILIES) {
      const input = new RegExp(
        `<label class="theme__font" data-font="${family.id}"><input type="radio"([^>]*)/>`,
      ).exec(html)?.[1];
      expect(input, family.id).toBeDefined();
      expect(input, family.id).toContain(`value="${family.id}"`);
      expect(input, family.id).toContain('checked=""');
      expect(html, family.id).toContain(`<b>${family.name}</b>`);
    }
    // The facts no longer say the fonts are fixed: the card says how a font joins.
    expect(html).not.toContain('<dt>Fonts</dt>');
    expect(html).toContain('A developer adds a font to this list once its licence is checked.');
    expect(html).toContain('Simple: one colour');
    expect(html).toContain('Advanced: every colour');
    expect(html).toMatch(/<label[^>]*for="theme-primary"[^>]*>Main colour/);
    expect(html).toContain('aria-label="Main colour: suggested colours"');
    expect(html).toContain('Save theme');
    expect(html).toContain('Reset to brand defaults');
    // The brand's own colours pass: no error note.
    expect(html).not.toContain('hard to read');
  });

  it('draws no empty card: the form’s own fields are all hidden (CR4)', () => {
    expect(html).not.toMatch(/<div class="card"><\/div>/);
    // Every card the screen draws has its heading.
    expect(html.match(/class="card"/g)).toHaveLength(7);
  });

  it('sets no style attribute: colours are SVG attributes (CSP, ui.md §1.6)', () => {
    expect(html).not.toMatch(/\sstyle=/);
    const preview = renderToStaticMarkup(
      createElement(SitePreview, { palette: paletteOf(DEFAULT_COLORS) }),
    );
    expect(preview).not.toMatch(/\sstyle=/);
    expect(preview).toContain('role="img"');
    expect(preview).toContain(`fill="${DEFAULT_COLORS.primary.toLowerCase()}"`);
    expect(preview).toContain(`fill="${DEFAULT_COLORS.accent.toLowerCase()}"`);
  });

  it('the sample draws the shapes and type: pill and card corners, weight and case (E12)', () => {
    const palette = paletteOf(DEFAULT_COLORS);
    const brand = renderToStaticMarkup(createElement(SitePreview, { palette }));
    // The brand's: pill buttons (22 px tall), cards at the site's 16 px drawn at half size,
    // headings in 800 and capitals.
    expect(brand).toContain('data-corners="brand"');
    expect(brand).toMatch(/<rect x="18" y="88" width="92" height="22" rx="11"/);
    expect(brand).toMatch(/<rect x="150" y="136" width="72" height="80" rx="8"/);
    expect(brand).toContain('font-weight="800"');
    expect(brand).toContain('FROM THE BRAIN TO THE');

    const themed = renderToStaticMarkup(
      createElement(SitePreview, {
        palette,
        shapes: { corners: 'round', buttons: 'square' },
        type: { headingWeight: 700, headingCase: 'as-written' },
      }),
    );
    expect(themed).toContain('data-corners="round"');
    expect(themed).toContain('data-buttons="square"');
    expect(themed).toContain('data-weight="700"');
    expect(themed).toContain('data-case="as-written"');
    expect(themed).toMatch(/<rect x="18" y="88" width="92" height="22" rx="0"/);
    expect(themed).toMatch(/<rect x="150" y="136" width="72" height="80" rx="12"/);
    expect(themed).not.toContain('font-weight="800"');
    expect(themed).toContain('From the brain to the');
    expect(themed).not.toMatch(/\sstyle=/);
  });

  it('the sample and the tiles draw each family in itself, by attribute (E13)', () => {
    const palette = paletteOf(DEFAULT_COLORS);
    const brand = renderToStaticMarkup(createElement(SitePreview, { palette }));
    const attr = (stack: string) => `font-family="${stack.replace(/'/g, '&#x27;')}"`;
    expect(brand).toContain('data-latin="archivo"');
    expect(brand).toContain('data-arabic="almarai"');
    expect(brand).toContain(`<g ${attr(brandFamily('latin').stack)}>`);
    const arabicLine = /<text [^>]*direction="rtl"[^>]*>/.exec(brand)?.[0] ?? '';
    expect(arabicLine).toContain(attr(brandFamily('arabic').stack));
    expect(html).toContain(attr(brandFamily('latin').stack));
    expect(html).toContain(attr(brandFamily('arabic').stack));
    expect(html).toContain('>Aa</text>');
    expect(html).toContain('>أب</text>');
  });
});
