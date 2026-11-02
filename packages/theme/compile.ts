import {
  THEME_TOKEN_NAMES,
  THEME_TOKEN_PATTERNS,
  ThemeTokensSchema,
  type ThemeTokens,
} from '../schemas/themeTokens';
import type { ThemeSettings } from '../schemas/theme';
import { channels } from './colour';
import { paletteOf } from './gate';
import { DEFAULT_COLORS, isDefaultColors } from './palette';

// Settings → tokens → CSS (Admin v2 E4, AV-27). The server compiles a theme's tokens from its
// settings on every save (the resource's toRow, src/lib/admin/resources/themes.ts), so a client
// never writes a token; the editor compiles the same way for its live preview. A token is
// written only where the theme DIFFERS from the brand: the brand's own settings compile to no
// token at all, and a theme with no token is not linked by any page (BaseLayout, AdminLayout),
// so a site reset to the defaults renders byte for byte as one that never had a theme.
//
// The glows and shadows are global.css's own (alpha, offsets and blur kept), recoloured.

/** The brand's own settings: what the editor starts from, and what Reset puts back. */
export const DEFAULT_THEME_SETTINGS: ThemeSettings = Object.freeze({
  v: 1,
  mode: 'simple',
  colors: { ...DEFAULT_COLORS },
  motion: { marquee: 'normal', reveal: true },
}) as ThemeSettings;

/**
 * The glow and shadow tokens: each one of the three named colours at a fixed alpha, behind a
 * fixed offset and blur (global.css's own, recoloured). One table for the compiler and the
 * database: packages/theme/sql.ts writes it into app.theme_row_ok, which then requires each
 * token to be exactly this string, so a direct write cannot put another colour or alpha
 * behind text (E4 review, E4-SEC-2: a white glow under .klein-band's white text).
 */
export const THEME_EFFECTS = [
  { token: '--bs-glow-klein', prefix: '', role: 'primary', alpha: '0.42' },
  { token: '--bs-glow-sky', prefix: '', role: 'accent', alpha: '0.45' },
  { token: '--bs-shadow-klein', prefix: '0 12px 38px ', role: 'primary', alpha: '0.45' },
  { token: '--bs-shadow-cobalt', prefix: '0 18px 48px ', role: 'hover', alpha: '0.45' },
] as const satisfies readonly {
  token: keyof ThemeTokens;
  prefix: string;
  role: 'primary' | 'hover' | 'accent';
  alpha: string;
}[];

const rgba = (hex: string, alpha: string) => {
  const rgb = channels(hex);
  if (!rgb) throw new Error(`not a colour: ${hex}`);
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
};

/** The tokens a theme's settings compile to (none for the brand's own). */
export function compileTheme(settings: ThemeSettings): ThemeTokens {
  const out: ThemeTokens = {};
  if (!isDefaultColors(settings.colors)) {
    const p = paletteOf(settings.colors);
    out['--bs-klein'] = p.primary;
    out['--bs-cobalt'] = p.hover;
    out['--bs-sky'] = p.accent;
    out['--bs-sky-soft'] = p.skySoft;
    for (const e of THEME_EFFECTS) out[e.token] = `${e.prefix}${rgba(p[e.role], e.alpha)}`;
  }
  if (settings.motion.marquee === 'slower') out['--bs-marquee-scale'] = '1.5';
  if (settings.motion.marquee === 'slowest') out['--bs-marquee-scale'] = '2.5';
  if (!settings.motion.reveal) {
    out['--bs-rv-from'] = '1';
    out['--bs-rv-shift'] = '0px';
  }
  return out;
}

/** Does this theme change anything? (No token: no page links it.) */
export function hasTokens(tokens: ThemeTokens | null | undefined): boolean {
  return !!tokens && THEME_TOKEN_NAMES.some((name) => tokens[name] !== undefined);
}

/**
 * The stylesheet: `:root{--name:value;…}`, the closed set in a fixed order, each value checked
 * against its key's pattern again here (a value that is not of its shape is left out, never
 * escaped), '' when nothing is left. Nothing else can be written: no selector but :root, no
 * property that is not a theme token, no `;` `{` `}` `<` `>` or backslash inside a value.
 */
export function themeCss(input: unknown): string {
  const parsed = ThemeTokensSchema.safeParse(input);
  if (!parsed.success) return '';
  const tokens = parsed.data;
  const lines: string[] = [];
  for (const name of THEME_TOKEN_NAMES) {
    const value = tokens[name];
    if (value === undefined || !THEME_TOKEN_PATTERNS[name].test(value)) continue;
    lines.push(`${name}:${value};`);
  }
  return lines.length > 0 ? `:root{${lines.join('')}}` : '';
}
