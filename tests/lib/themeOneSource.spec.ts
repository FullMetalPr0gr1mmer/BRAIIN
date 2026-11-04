import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// One source for each of the theme's shape facts (Admin v2 E12 code review CR7, CR9): the
// upgrade of an older theme (v1, and since E13 v2, to v3) is written once (packages/theme/shapes.ts upgradeThemeSettings) and every
// reader of a v1 theme goes through it; the editor's sample draws the buttons from the site's
// own radius table (BUTTON_RADIUS), not a copy of it. Proven by replacing the module's two
// facts here: a reader with its own copy would not follow.

const seen = vi.hoisted(() => ({ upgrades: 0 }));

vi.mock('@theme/shapes', async (load) => {
  const real = await load<typeof import('@theme/shapes')>();
  return {
    ...real,
    // Rounded buttons at 12 px instead of 10 (the sample draws them at half size: 6).
    BUTTON_RADIUS: Object.freeze({ ...real.BUTTON_RADIUS, rounded: 12 }),
    upgradeThemeSettings: (stored: unknown) => {
      seen.upgrades += 1;
      return real.upgradeThemeSettings(stored);
    },
  };
});

const { ThemeSettingsSchema } = await import('@schemas/theme');
const { compileTheme } = await import('@theme/compile');
const { paletteOf } = await import('@theme/gate');
const { DEFAULT_COLORS } = await import('@theme/palette');
const { settingsOf } = await import('@/components/admin/screens/theme/model');
const { default: SitePreview } = await import('@/components/admin/screens/theme/SitePreview');

const V1 = {
  v: 1,
  mode: 'simple',
  colors: { primary: '#0024BC', hover: '#024CFF', accent: '#22A9FF' },
  motion: { marquee: 'slower', reveal: false },
} as const;
const AS_V3 = {
  ...V1,
  v: 3,
  shapes: { corners: 'brand', buttons: 'pill' },
  type: { headingWeight: 800, headingCase: 'uppercase' },
  fonts: { latin: 'archivo', arabic: 'almarai' },
};

beforeEach(() => {
  seen.upgrades = 0;
});

describe('a v1 theme is upgraded in one place', () => {
  it('the schema reads it through upgradeThemeSettings', () => {
    expect(ThemeSettingsSchema.parse(V1)).toEqual(AS_V3);
    expect(seen.upgrades).toBe(1);
  });

  it('the compiler reads it through upgradeThemeSettings', () => {
    expect(compileTheme(V1)).toEqual({
      '--bs-marquee-scale': '1.5',
      '--bs-rv-from': '1',
      '--bs-rv-shift': '0px',
    });
    expect(seen.upgrades).toBe(1);
  });

  it("the editor's settingsOf reads it through upgradeThemeSettings", () => {
    expect(settingsOf(V1)).toEqual(AS_V3);
    expect(seen.upgrades).toBe(1);
  });
});

describe("the editor's sample draws the site's own button radii", () => {
  it('a rounded button is BUTTON_RADIUS at half size; a pill stays half the height', () => {
    const palette = paletteOf(DEFAULT_COLORS);
    const draw = (buttons: 'pill' | 'rounded' | 'square') =>
      renderToStaticMarkup(
        createElement(SitePreview, {
          palette,
          shapes: { corners: 'brand', buttons },
          type: { headingWeight: 800, headingCase: 'uppercase' },
        }),
      );
    expect(draw('rounded')).toMatch(/<rect x="18" y="88" width="92" height="22" rx="6"/);
    expect(draw('pill')).toMatch(/<rect x="18" y="88" width="92" height="22" rx="11"/);
    expect(draw('square')).toMatch(/<rect x="18" y="88" width="92" height="22" rx="0"/);
  });
});
