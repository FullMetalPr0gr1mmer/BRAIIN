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
 *   shapes     (E12) the corner scale over the site's card, image and input radii (square 0,
 *              soft 0.5, round 1.5) and the buttons' radius (rounded 10px, square 0px)
 *   type       (E12) the headings' weight (bold 700) and case (as written: none)
 *   fonts      (E13) the English and the Arabic pages' font stacks: exactly the stack of a
 *              family of the font catalogue that is not the brand's (packages/theme/fonts.ts).
 *              The brand's is the stylesheets' own `:root` stack and is never written. Owner
 *              item O-21 is open, so the catalogue has no other family yet and each pattern is
 *              `^(?!)`, which matches nothing (in Postgres too). Literals here, because this
 *              module keeps to zod alone; tests/lib/fontCatalogue.spec.ts holds each equal to
 *              fontTokenPattern() over the catalogue, so a family added there fails until its
 *              stack is here (and in a migration that restates app.theme_row_ok).
 *
 * Each pattern takes only the values a theme can choose that differ from the brand's: the
 * brand's own is the stylesheets' fallback and is never written (packages/theme/compile.ts).
 *
 * The database holds the same patterns (the E4 migration's app.theme_row_ok; tests/lib/
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
  '--bs-radius-scale': /^(0|0\.5|1\.5)$/,
  '--bs-btn-radius': /^(10px|0px)$/,
  '--bs-heading-weight': /^700$/,
  '--bs-heading-case': /^none$/,
  '--bs-font-sans': /^(?!)/,
  '--bs-font-ar': /^(?!)/,
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
  '--bs-radius-scale',
  '--bs-btn-radius',
  '--bs-heading-weight',
  '--bs-heading-case',
  '--bs-font-sans',
  '--bs-font-ar',
];

/** The tokens whose value is a font stack: longer than the others (a whole stack). */
export const FONT_STACK_TOKENS = ['--bs-font-sans', '--bs-font-ar'] as const;

/** A token value's longest: 60 characters, a font stack 160. */
export function tokenMax(name: ThemeTokenName): number {
  return (FONT_STACK_TOKENS as readonly string[]).includes(name) ? 160 : 60;
}

/** One token's value: its key's shape, never longer than its limit (tokenMax), and optional. */
const tokenValue = (pattern: RegExp, max: number) => z.string().max(max).regex(pattern).optional();

type TokenShape = { [K in ThemeTokenName]: ReturnType<typeof tokenValue> };

/**
 * One entry per pattern, built from THEME_TOKEN_PATTERNS (E12 code review CR10), so a key and
 * its shape are written once: a key added to the patterns is in the schema with that pattern.
 */
function tokenShape(): TokenShape {
  const shape = {} as TokenShape;
  for (const name of Object.keys(THEME_TOKEN_PATTERNS) as ThemeTokenName[]) {
    shape[name] = tokenValue(THEME_TOKEN_PATTERNS[name], tokenMax(name));
  }
  return shape;
}

export const ThemeTokensSchema = z.object(tokenShape()).strict();

export type ThemeTokens = z.infer<typeof ThemeTokensSchema>;
