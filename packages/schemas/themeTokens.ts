import { z } from 'zod';

/**
 * Theme tokens are CSS CUSTOM PROPERTIES ONLY (CLAUDE.md §7), and since Admin v2 E4 a CLOSED
 * set: each key the theme can set, with the one shape its value may take. A value can never
 * hold `;` `{` `}` `<` `>` or a backslash, so a token cannot break out of its declaration in
 * /styles/theme.css, in the preview's nonced <style>, or through `style.setProperty`.
 *
 *   colours    primary, hover, accent and the derived light accent tint: `#rrggbb`
 *   glows      `rgba(r, g, b, 0.nn)` from primary and accent
 *   shadows    `0 Npx Npx rgba(r, g, b, 0.nn)` from primary and hover
 *   motion     the marquee's duration scale (slower 1.5, slowest 2.5) and reveal off (the
 *              starting opacity 1 and no shift): they can only reduce motion (README E4)
 *
 * The database holds the same patterns (the E4 migration's app.theme_tokens_ok; tests/lib/
 * themeSql.spec.ts holds them equal). The module keeps to zod alone: the preview bridge's
 * chunk (admin-zod) carries it.
 */
export const THEME_TOKEN_PATTERNS = {
  '--bs-klein': /^#[0-9a-f]{6}$/,
  '--bs-cobalt': /^#[0-9a-f]{6}$/,
  '--bs-sky': /^#[0-9a-f]{6}$/,
  '--bs-sky-soft': /^#[0-9a-f]{6}$/,
  '--bs-glow-klein': /^rgba\([0-9]{1,3}, [0-9]{1,3}, [0-9]{1,3}, 0\.[0-9]{1,2}\)$/,
  '--bs-glow-sky': /^rgba\([0-9]{1,3}, [0-9]{1,3}, [0-9]{1,3}, 0\.[0-9]{1,2}\)$/,
  '--bs-shadow-klein':
    /^0 [0-9]{1,2}px [0-9]{1,2}px rgba\([0-9]{1,3}, [0-9]{1,3}, [0-9]{1,3}, 0\.[0-9]{1,2}\)$/,
  '--bs-shadow-cobalt':
    /^0 [0-9]{1,2}px [0-9]{1,2}px rgba\([0-9]{1,3}, [0-9]{1,3}, [0-9]{1,3}, 0\.[0-9]{1,2}\)$/,
  '--bs-marquee-scale': /^(1\.5|2\.5)$/,
  '--bs-rv-from': /^1$/,
  '--bs-rv-shift': /^0px$/,
} as const;

export type ThemeTokenName = keyof typeof THEME_TOKEN_PATTERNS;

/** The keys, in the order theme.css writes them (tests/lib/themeTokens.spec.ts: every key once). */
export const THEME_TOKEN_NAMES: readonly ThemeTokenName[] = [
  '--bs-klein',
  '--bs-cobalt',
  '--bs-sky',
  '--bs-sky-soft',
  '--bs-glow-klein',
  '--bs-glow-sky',
  '--bs-shadow-klein',
  '--bs-shadow-cobalt',
  '--bs-marquee-scale',
  '--bs-rv-from',
  '--bs-rv-shift',
];

export const ThemeTokensSchema = z
  .object({
    '--bs-klein': z.string().max(60).regex(THEME_TOKEN_PATTERNS['--bs-klein']).optional(),
    '--bs-cobalt': z.string().max(60).regex(THEME_TOKEN_PATTERNS['--bs-cobalt']).optional(),
    '--bs-sky': z.string().max(60).regex(THEME_TOKEN_PATTERNS['--bs-sky']).optional(),
    '--bs-sky-soft': z.string().max(60).regex(THEME_TOKEN_PATTERNS['--bs-sky-soft']).optional(),
    '--bs-glow-klein': z.string().max(60).regex(THEME_TOKEN_PATTERNS['--bs-glow-klein']).optional(),
    '--bs-glow-sky': z.string().max(60).regex(THEME_TOKEN_PATTERNS['--bs-glow-sky']).optional(),
    '--bs-shadow-klein': z.string().max(60).regex(THEME_TOKEN_PATTERNS['--bs-shadow-klein']).optional(),
    '--bs-shadow-cobalt': z.string().max(60).regex(THEME_TOKEN_PATTERNS['--bs-shadow-cobalt']).optional(),
    '--bs-marquee-scale': z.string().max(60).regex(THEME_TOKEN_PATTERNS['--bs-marquee-scale']).optional(),
    '--bs-rv-from': z.string().max(60).regex(THEME_TOKEN_PATTERNS['--bs-rv-from']).optional(),
    '--bs-rv-shift': z.string().max(60).regex(THEME_TOKEN_PATTERNS['--bs-rv-shift']).optional(),
  })
  .strict();

export type ThemeTokens = z.infer<typeof ThemeTokensSchema>;
