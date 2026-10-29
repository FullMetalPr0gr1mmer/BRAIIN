import pairs from './pairs.json';
import { fromHsl, normalizeColour, toHsl } from './colour';

// The theme's colours (Admin v2 E4, AV-27). v1 themes the three colours the site and the admin
// already draw through a token: primary (--bs-klein), hover (--bs-cobalt) and accent (--bs-sky,
// which --bs-accent reads). The dark ground, the light section and the paper stay fixed (as-built
// E4, Departures). The light accent tint (--bs-sky-soft) is derived, never chosen.

export const THEME_ROLES = ['primary', 'hover', 'accent'] as const;
export type ThemeRole = (typeof THEME_ROLES)[number];
export type ThemeColors = Record<ThemeRole, string>;

/** The brand's own colours: what global.css and admin.css draw with no theme. Upper case. */
export const DEFAULT_COLORS: Readonly<ThemeColors> = Object.freeze({
  primary: pairs.defaults.primary,
  hover: pairs.defaults.hover,
  accent: pairs.defaults.accent,
});

/** global.css's --bs-sky-soft: the tint the site draws while the colours are the defaults. */
export const DEFAULT_SKY_SOFT = pairs.defaults.skySoft;

/** The eight swatches Simple mode offers (the prototype's, screens_ops.js). */
export const THEME_SWATCHES = [
  '#0024BC',
  '#024CFF',
  '#0B6EB0',
  '#7A5AF8',
  '#12B76A',
  '#F79009',
  '#E4457B',
  '#000000',
] as const;

/** Are these the brand's own colours (case does not matter)? */
export function isDefaultColors(colors: Readonly<ThemeColors>): boolean {
  return THEME_ROLES.every(
    (role) => normalizeColour(colors[role]) === normalizeColour(DEFAULT_COLORS[role]),
  );
}

/**
 * Simple mode: one main colour becomes the palette, by the prototype's HSL rules (opsPalette):
 * hover a touch brighter, "like Klein to cobalt"; accent the "sky" that sits on black sections.
 * Upper case. The gate may then move a generated colour (settle, gate.ts).
 */
export function generatePalette(primary: string): ThemeColors {
  const main = normalizeColour(primary);
  if (!main) throw new Error(`not a colour: ${primary}`);
  const [h, s, l] = toHsl(main);
  return {
    primary: main,
    hover: fromHsl(h + 2, Math.min(100, s + 6), Math.min(62, l + 14)).toUpperCase(),
    accent: fromHsl(h - 20, Math.min(100, s + 4), 56).toUpperCase(),
  };
}
