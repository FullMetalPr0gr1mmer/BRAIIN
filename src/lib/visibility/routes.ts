import type { Locale } from '@schemas/primitives';

// Which public routes page visibility can gate (Admin v2 U14a), keyed on the ROUTE Astro
// matched, never on the path string. `context.routePattern` is the page file's own route
// (`/about`, `/ar/services/[slug]`), so `%2F`, `%5C`, dot segments and doubled slashes cannot
// reach a page without its pattern coming along (the F7 lesson in src/middleware.ts's header:
// the router and `url.pathname` can disagree, and the route is what renders).
//
// Pure, with type-only imports: the middleware imports it, and so do the menus, the sitemap,
// llms.txt, the search endpoint and the admin. tests/lib/visibilityRoutes.spec.ts holds the
// map to the files in src/pages: every public route is either mapped here or named as not
// gateable, so a new page cannot be added without a decision.

/** A CMS page's slug (`pages.slug`) → its English path. The Arabic twin is `/ar` + it. */
export const PAGE_PATHS = {
  home: '/',
  about: '/about',
  contact: '/contact',
  join: '/join',
  services: '/services',
  portfolio: '/portfolio',
  'portfolio-all': '/portfolio/all',
} as const;

export type VisibilityPageSlug = keyof typeof PAGE_PATHS;

/** The page that is always public (to take the whole site down: maintenance mode). */
export const HOME_SLUG: VisibilityPageSlug = 'home';

export const VISIBILITY_TEMPLATES = ['service', 'case_study'] as const;
export type VisibilityTemplate = (typeof VISIBILITY_TEMPLATES)[number];

/** A template → the English route of every page it renders. */
export const TEMPLATE_ROUTES: Readonly<Record<VisibilityTemplate, string>> = {
  service: '/services/[slug]',
  case_study: '/portfolio/[slug]',
};

export type VisibilityTarget =
  { kind: 'page'; slug: VisibilityPageSlug } | { kind: 'template'; template: VisibilityTemplate };

export function isVisibilityPageSlug(value: unknown): value is VisibilityPageSlug {
  return typeof value === 'string' && Object.hasOwn(PAGE_PATHS, value);
}

export function isVisibilityTemplate(value: unknown): value is VisibilityTemplate {
  return typeof value === 'string' && (VISIBILITY_TEMPLATES as readonly string[]).includes(value);
}

const arabic = (path: string): string => (path === '/' ? '/ar' : `/ar${path}`);

/** Route pattern (EN and AR) → what it renders. Built once from the two maps above. */
const BY_ROUTE: ReadonlyMap<string, VisibilityTarget> = (() => {
  const map = new Map<string, VisibilityTarget>();
  for (const [slug, path] of Object.entries(PAGE_PATHS)) {
    const target: VisibilityTarget = { kind: 'page', slug: slug as VisibilityPageSlug };
    map.set(path, target).set(arabic(path), target);
  }
  for (const [template, route] of Object.entries(TEMPLATE_ROUTES)) {
    const target: VisibilityTarget = { kind: 'template', template: template as VisibilityTemplate };
    map.set(route, target).set(arabic(route), target);
  }
  return map;
})();

/** Every route pattern the gate knows, EN and AR. */
export const GATED_ROUTES: readonly string[] = [...BY_ROUTE.keys()];

/**
 * What the route Astro matched renders, or null for a route page visibility does not gate
 * (the legal pages, the blog, search, the 404s, every endpoint) and for a context with no
 * route at all.
 */
export function targetForRoute(routePattern: string | null | undefined): VisibilityTarget | null {
  if (!routePattern) return null;
  return BY_ROUTE.get(routePattern) ?? null;
}

/**
 * What a LOGICAL path (no `/ar` prefix, no query or fragment) renders, for the readers that
 * hold paths rather than routes: the menus' hrefs, the sitemap's and llms.txt's entries.
 * `/portfolio/all` is the All projects page, never a case study (a static route beats
 * `[slug]`, and the slug `all` is reserved, CLAUDE.md §8).
 */
export function targetForPath(logicalPath: string): VisibilityTarget | null {
  const path = logicalPath.length > 1 ? logicalPath.replace(/\/+$/, '') || '/' : logicalPath;
  for (const [slug, own] of Object.entries(PAGE_PATHS)) {
    if (own === path) return { kind: 'page', slug: slug as VisibilityPageSlug };
  }
  const child = /^\/(services|portfolio)\/([^/]+)$/.exec(path);
  if (child)
    return { kind: 'template', template: child[1] === 'services' ? 'service' : 'case_study' };
  return null;
}

/** A CMS page's path in a language: `/about`, `/ar/about`; the homepage `/` and `/ar`. */
export function localizedPagePath(slug: VisibilityPageSlug, locale: Locale): string {
  const path = PAGE_PATHS[slug];
  return locale === 'ar' ? arabic(path) : path;
}
