import type { Locale } from '@schemas/primitives';

// The ONE font preload per route (CLAUDE.md §6 "preload only the hero face"; docs/fonts.md).
// EN always preloads the Archivo variable face (every weight in one file). AR preloads the
// Almarai weight the route's above-the-fold heading actually renders in — Almarai is static
// 400/700/800, so a heading at another weight resolves to one of those, and preloading the
// wrong one leaves the right one to swap in late and reflow the heading (CLS). Home's hero
// is 800; About's "who" h1 is font-weight 600, which renders with the 700 face.

export const HERO_FACES = ['almarai-700', 'almarai-800'] as const;
export type HeroFace = (typeof HERO_FACES)[number];

/** The preload href for a route's hero face. `face` applies to Arabic only. */
export function heroFontPreload(locale: Locale, face: HeroFace = 'almarai-800'): string {
  return locale === 'ar' ? `/fonts/${face}-arabic.woff2` : '/fonts/archivo-var-latin.woff2';
}
