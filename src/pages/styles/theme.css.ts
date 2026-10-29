import type { APIRoute } from 'astro';
import { themeCss } from '@theme/compile';
import { getActiveTheme } from '@/lib/data/theme';

// The site's theme as a stylesheet (Admin v2 E4, AV-27): `/styles/theme.css?v=<version>`.
// Same-origin, so the strict CSP's `style-src 'self'` takes it with no nonce and no inline
// style anywhere (CLAUDE.md §3, §7). Its whole body is one `:root{…}` rule of the active
// theme's custom properties, each re-checked against its key's shape (themeCss): nothing but
// the closed token set can be written.
//
// BaseLayout and AdminLayout link it only while a theme sets a token, with the live version in
// the address, so the right address is a fixed file: immutable for a year. Any other address
// (an older version, none, a theme since reset) answers the CURRENT theme for a minute only, so
// a page cached with an older link still draws today's colours within a minute and nothing
// stale is kept. Every answer carries `site:chrome`, the tag a theme's publish purges.

export const prerender = false;

export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const SHORT = 'public, max-age=60, must-revalidate';

export const GET: APIRoute = async ({ url, locals }) => {
  const theme = await getActiveTheme(locals);
  const body = theme ? themeCss(theme.tokens) : '';
  const current = theme !== null && url.searchParams.get('v') === String(theme.version);
  return new Response(body ? `${body}\n` : '', {
    headers: {
      'content-type': 'text/css; charset=utf-8',
      'cache-control': current ? IMMUTABLE : SHORT,
      'cache-tag': 'site:chrome',
    },
  });
};
