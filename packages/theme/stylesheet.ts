import { ThemeTokensSchema } from '../schemas/themeTokens';
import { themeCss } from './compile';
import { chosenFontFaces } from './fontFaces';

// /styles/theme.css's body (Admin v2 E4, E13). SERVER ONLY: it reads the font catalogue's faces
// (packages/theme/fontFaces.ts), which no browser bundle carries.
//
// The tokens' `:root` rule (themeCss), after the `@font-face` rules of each font family the
// tokens choose that is not the brand's (global.css declares the brand's): the faces are the
// catalogue's own text, picked by the font token's value, which the closed set has already held
// to exactly one family's stack, so nothing from the row reaches the stylesheet but as a key.
// A theme without a font token (every theme while the catalogue holds only the brand's, O-21)
// gets exactly the body E4 and E12 wrote. Tokens outside the closed set: '' (themeCss's rule).

export function themeStylesheet(input: unknown): string {
  const parsed = ThemeTokensSchema.safeParse(input);
  if (!parsed.success) return '';
  const css = themeCss(parsed.data);
  if (!css) return '';
  return `${chosenFontFaces(parsed.data)}${css}`;
}
