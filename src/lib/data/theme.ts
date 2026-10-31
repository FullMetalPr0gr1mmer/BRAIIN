import { ThemeTokensSchema, type ThemeTokens } from '@schemas/themeTokens';
import { hasTokens } from '@theme/compile';
import { supabaseConfigured } from '@/lib/supabase/client';
import { reportLoadError } from './parse';
import { contentClient } from './source';

// The site's active theme (Admin v2 E4, AV-27), as a visitor reads it: the tokens and version
// of the tenant's ACTIVE v1 theme (0118's custom_themes_public_read and its column grant, the
// anon fence first), through the content seam, so the releases preview reads the pending theme
// in its place. Read once per request (`locals.theme`, a promise, as `locals.identity`) by
// BaseLayout and AdminLayout, which link /styles/theme.css only when the theme sets a token,
// and by that stylesheet's route.
//
// Never throws and never fails a page: no theme is the brand's own look, which every page
// already renders. An unconfigured database, a refused or failed read, no row, more than one
// (the unique index allows one), and tokens that are not the closed set (the CHECK and this
// schema are the same rules) all answer null, the last three reported.

export interface ActiveTheme {
  tokens: ThemeTokens;
  version: number;
}

/** The columns a visitor may read of a theme, and the only ones this asks for. */
export const THEME_COLUMNS = 'tokens,version';

export async function readActiveTheme(): Promise<ActiveTheme | null> {
  if (!supabaseConfigured()) return null;
  try {
    const { data, error } = await contentClient()
      .from('custom_themes')
      .select(THEME_COLUMNS)
      .limit(2);
    if (error) {
      reportLoadError('custom_themes', error);
      return null;
    }
    const rows = (data ?? []) as Record<string, unknown>[];
    if (rows.length === 0) return null;
    if (rows.length > 1) {
      reportLoadError('custom_themes', new Error('more than one active theme'));
      return null;
    }
    const row = rows[0]!;
    const tokens = ThemeTokensSchema.safeParse(row['tokens']);
    const version = row['version'];
    if (!tokens.success || typeof version !== 'number' || !Number.isInteger(version)) {
      reportLoadError('custom_themes', new Error('the active theme is not a v1 theme'));
      return null;
    }
    return { tokens: tokens.data, version };
  } catch (err) {
    reportLoadError('custom_themes', err);
    return null;
  }
}

type ThemeLocals = Pick<App.Locals, 'theme'>;

/** The active theme, once per request; null for none or the brand's own (no token set). */
export function getActiveTheme(locals: ThemeLocals): Promise<ActiveTheme | null> {
  locals.theme ??= readActiveTheme().then((theme) =>
    theme && hasTokens(theme.tokens) ? theme : null,
  );
  return locals.theme;
}

/** The stylesheet's route (src/pages/styles/theme.css.ts); the middleware knows it by this. */
export const THEME_STYLESHEET_PATH = '/styles/theme.css';

/** The stylesheet's address for a theme: versioned, so a new theme is a new URL. */
export function themeHref(theme: ActiveTheme): string {
  return `${THEME_STYLESHEET_PATH}?v=${theme.version}`;
}
