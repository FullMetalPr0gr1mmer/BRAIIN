import type { APIRoute } from 'astro';
import { THEME_HASH_PATTERN, getActiveTheme } from '@/lib/data/theme';

// The site's theme as a stylesheet (Admin v2 E4, AV-27): `/styles/theme.css?v=<hash>`.
// Same-origin, so the strict CSP's `style-src 'self'` takes it with no nonce and no inline
// style anywhere (CLAUDE.md §3, §7). Its whole body is one `:root{…}` rule of the active
// theme's custom properties, each re-checked against its key's shape (themeCss): nothing but
// the closed token set can be written.
//
// BaseLayout and AdminLayout link it only while a theme sets a token, with the hash of the
// body in the address (themeHash: 16 hex digits of its SHA-256), so the right address is a
// fixed file: immutable for a year, tagged `site:chrome`, the tag a theme's publish purges.
// The hash, not the row's version, because a version comes back (a theme deleted and created
// again starts at 1), and a browser keeps an immutable answer whatever the edge purges (E4
// review, E4-SEC-1).
//
// Any other well-formed address (an older theme's, a theme since reset, or 16 hex digits made
// up) answers the CURRENT theme's body, `no-store` (E4 code review CR2): a page still holding
// an older link draws today's colours, and nothing is kept, so made-up addresses fill no cache
// and each costs at most the one read. Chosen over a redirect to the live address: no extra
// round trip for the page that holds an old link, and nothing to answer when there is no theme.
// A read that failed answers the same way (empty, `no-store`): a blip is never kept.
//
// An address that is not exactly `?v=<16 hex>` (none, a number, anything appended) is no
// stylesheet any page links: an empty body, `no-store`, and no database read (E4-SEC-4).

export const prerender = false;

export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const NOT_LINKED = 'no-store';

const CSS = 'text/css; charset=utf-8';

export const GET: APIRoute = async ({ url, locals }) => {
  const v = url.search.startsWith('?v=') ? url.search.slice(3) : '';
  if (!THEME_HASH_PATTERN.test(v)) {
    return new Response('', { headers: { 'content-type': CSS, 'cache-control': NOT_LINKED } });
  }
  const theme = await getActiveTheme(locals);
  const body = theme ? `${theme.css}\n` : '';
  if (theme === null || v !== theme.hash) {
    return new Response(body, { headers: { 'content-type': CSS, 'cache-control': NOT_LINKED } });
  }
  return new Response(body, {
    headers: { 'content-type': CSS, 'cache-control': IMMUTABLE, 'cache-tag': 'site:chrome' },
  });
};
