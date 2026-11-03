import type { Locale } from '@schemas/primitives';
import { familyForTokens } from '@theme/fonts';
import { heroFile } from '@theme/fontFaces';

// The ONE font preload per route (CLAUDE.md §6 "preload only the hero face"; docs/fonts.md).
// The face to preload is the file the route's above-the-fold heading actually renders in: its
// page's family (the brand's, or the one the theme chose from the font catalogue, Admin v2 E13)
// at the heading's CSS weight. A static family resolves a weight it has no file for to a
// neighbour, as the browser does (Almarai is 400/700/800, so About's 600 h1 renders with the 700
// face), and preloading the wrong file leaves the right one to swap in late and reflow the
// heading (CLS: /ar/about once paid 0.14). A variable family (Archivo) has one file for every
// weight. Home's hero is 800; About's "who" h1 is 600.

/** The CSS weight a route's above-the-fold heading is set in. */
export type HeroWeight = 600 | 700 | 800;
/** Every weight a route names, or a Bold theme turns its heading to (the hero budget's list). */
export const HERO_WEIGHTS: readonly HeroWeight[] = [600, 700, 800];

/** Theme tokens as a page reads them (only the two font tokens matter here). */
type Tokens = Readonly<Partial<Record<string, string | undefined>>> | null | undefined;

/**
 * The preload href for a route's hero face: the page's family (`--bs-font-sans` for English,
 * `--bs-font-ar` for Arabic; no token is the brand's) at the heading's weight.
 */
export function heroFontPreload(
  locale: Locale,
  weight: HeroWeight = 800,
  tokens: Tokens = undefined,
): string {
  const family = familyForTokens(locale === 'ar' ? 'arabic' : 'latin', tokens);
  return heroFile(family, weight);
}

/**
 * The heading's weight once the theme's heading weight applies (Admin v2 E12, AV-32). A theme
 * that sets the headings in Bold (`--bs-heading-weight: 700`) draws an 800 heading at 700, so
 * the 700 face is the one to preload; preloading 800 would leave the 700 face to swap in late.
 * A route whose heading is not 800 keeps its weight (E12 themes only the 800 headings), and no
 * theme, or the brand's weight (no token), keeps the route's own.
 */
export function themedHeroWeight(
  weight: HeroWeight,
  headingWeight: string | undefined,
): HeroWeight {
  return weight === 800 && headingWeight === '700' ? 700 : weight;
}
