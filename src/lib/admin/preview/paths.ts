// Which public paths the preview renders, and how a public path and its preview path map
// onto each other (Admin v2 R9). Pure and client-safe: the server's route map
// (src/lib/preview/routes.ts) and the in-preview bridge (bridge.ts here) both read it, so a
// link the bridge keeps inside the preview is exactly a path the server will render there.
//
// The list is the Tier A pages (CLAUDE.md §2), EN and their `/ar` twins: the CMS pages, the
// service and case-study templates, the blog, the legal pages, search and the 404 page.
// Endpoints (feeds, the sitemap, llms.txt, robots.txt, /healthz, /api) are not pages and
// are never previewed. tests/lib/previewRoutes.spec.ts holds this list to the page files in
// src/pages, so a new public page cannot be added without a decision here.
//
// A slug segment is held to letters, digits and hyphens before anything renders it: the
// path is handed to Astro's rewrite, so no `%`, dot segment, backslash or second slash ever
// reaches the router from here.

export const PREVIEW_PREFIX = '/admin/preview';

/**
 * The site's API endpoints a preview may read: each answers a GET without writing anything.
 * `/api/search` is not one (it records every query, `recordSearchQuery`). The bridge refuses
 * every other request to `/api/**` (bridge.ts), and a preview render's CSP lists only these
 * in `connect-src` (src/lib/http/preview.ts), so the browser refuses the rest as well, even a
 * request a page script sends before the bridge is installed.
 */
export const READ_ONLY_ENDPOINTS: readonly string[] = ['/api/apply/status'];

const SLUG = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,118}[A-Za-z0-9])?';

/** Every previewable LOGICAL path (no `/ar`), as a pattern, with the route it renders. */
export const PREVIEW_ROUTES: readonly { route: string; pattern: RegExp }[] = [
  { route: '/', pattern: /^\/$/ },
  { route: '/about', pattern: /^\/about$/ },
  { route: '/contact', pattern: /^\/contact$/ },
  { route: '/join', pattern: /^\/join$/ },
  { route: '/services', pattern: /^\/services$/ },
  { route: '/services/[slug]', pattern: new RegExp(`^/services/${SLUG}$`) },
  { route: '/portfolio', pattern: /^\/portfolio$/ },
  { route: '/portfolio/all', pattern: /^\/portfolio\/all$/ },
  { route: '/portfolio/[slug]', pattern: new RegExp(`^/portfolio/${SLUG}$`) },
  { route: '/creative-knowledge', pattern: /^\/creative-knowledge$/ },
  {
    route: '/creative-knowledge/[slug]',
    pattern: new RegExp(`^/creative-knowledge/${SLUG}$`),
  },
  { route: '/search', pattern: /^\/search$/ },
  { route: '/privacy', pattern: /^\/privacy$/ },
  { route: '/terms', pattern: /^\/terms$/ },
  { route: '/cookie-policy', pattern: /^\/cookie-policy$/ },
  { route: '/404', pattern: /^\/404$/ },
];

/** A public path, split: its language and its logical path (`/ar/about` → ar, `/about`). */
export function splitLocale(pathname: string): { locale: 'en' | 'ar'; logical: string } {
  if (pathname === '/ar') return { locale: 'ar', logical: '/' };
  if (pathname.startsWith('/ar/')) return { locale: 'ar', logical: pathname.slice(3) };
  return { locale: 'en', logical: pathname };
}

/** The route a public pathname renders in the preview, or null when it is not previewed. */
export function previewRouteOf(pathname: string): string | null {
  const bare = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  const { logical } = splitLocale(bare);
  return PREVIEW_ROUTES.find((r) => r.pattern.test(logical))?.route ?? null;
}

/** Public pathname → preview pathname (`/` → `/admin/preview`), or null. Query kept. */
export function toPreviewPath(publicPath: string): string | null {
  const q = publicPath.search(/[?#]/);
  const pathname = q === -1 ? publicPath : publicPath.slice(0, q);
  const rest = q === -1 ? '' : publicPath.slice(q);
  if (previewRouteOf(pathname) === null) return null;
  const bare = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  return `${PREVIEW_PREFIX}${bare === '/' ? '' : bare}${rest}`;
}

/** Preview pathname → the public pathname it previews (`/admin/preview` → `/`), or null. */
export function fromPreviewPath(pathname: string): string | null {
  if (pathname === PREVIEW_PREFIX || pathname === `${PREVIEW_PREFIX}/`) return '/';
  if (!pathname.startsWith(`${PREVIEW_PREFIX}/`)) return null;
  const rest = pathname.slice(PREVIEW_PREFIX.length);
  const bare = rest.length > 1 ? rest.replace(/\/$/, '') : rest;
  return previewRouteOf(bare) === null ? null : bare;
}
