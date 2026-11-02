// Custom pages (Admin v2 E11, docs/admin-v2/ui.md AV-33): what address a page made with "New
// page" may take, and which section types it may hold.
//
// Dependency-free on purpose, like sectionTypes.ts: the New page dialog (an admin island), the
// public `[slug]` routes, the preview's route map and the middleware's route map all import it,
// and none of them should carry zod or a schema module for a list of words.
//
// A custom page is a `pages` row whose slug is not one of the seven ROUTE slugs (the pages the
// site's own files render, src/lib/visibility/routes.ts PAGE_PATHS, held equal by
// tests/lib/customPages.spec.ts). It renders at `/<slug>` and `/ar/<slug>`, so its slug must
// never be a path something else answers: every top-level route file in src/pages, every
// top-level folder of public/ (the asset layer answers those before the Worker), the Worker's
// and Cloudflare's own paths, and the language prefixes. The spec walks src/pages and public/,
// so a new top-level route cannot ship without its word here. 0123 (app.tg_pages_slug_rules)
// holds the same two lists in SQL, for every writer; the spec holds the literals equal.

/** The slugs of the pages the site's own route files render (PAGE_PATHS' keys). */
export const ROUTE_PAGE_SLUGS = [
  'home',
  'about',
  'contact',
  'join',
  'services',
  'portfolio',
  'portfolio-all',
] as const;

/** Words no custom page may take: paths something else answers, or would be mistaken for. */
export const RESERVED_PAGE_SLUGS = [
  // Top-level route files in src/pages that are not CMS pages, and their folders.
  '404',
  'admin',
  'api',
  'ar',
  'cookie-policy',
  'creative-knowledge',
  'healthz',
  'index',
  'llms',
  'manifest',
  'privacy',
  'robots',
  'search',
  'sitemap',
  'styles',
  'terms',
  // Top-level folders of public/ (served by the asset layer before the Worker runs).
  'fonts',
  'media',
  'og',
  'scripts',
  // Cloudflare's own path, and names a visitor would read as the site's machinery.
  'cdn-cgi',
  'en',
  'www',
  'assets',
  'static',
  'feed',
  'rss',
  'preview',
] as const;

/** A custom page's address is at most this long (a URL segment people read and share). */
export const CUSTOM_PAGE_SLUG_MAX = 64;

/** Lowercase letters and digits in words joined by single hyphens. */
export const PAGE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const ROUTE: ReadonlySet<string> = new Set(ROUTE_PAGE_SLUGS);
const RESERVED: ReadonlySet<string> = new Set(RESERVED_PAGE_SLUGS);

export function isRoutePageSlug(value: unknown): value is (typeof ROUTE_PAGE_SLUGS)[number] {
  return typeof value === 'string' && ROUTE.has(value);
}

export function isReservedPageSlug(value: string): boolean {
  return RESERVED.has(value);
}

/** Why a custom page cannot take this address, in plain words; null when it can. */
export function customPageSlugProblem(value: string): string | null {
  if (value.length === 0) return 'Give the page an address.';
  if (value.length > CUSTOM_PAGE_SLUG_MAX) {
    return `Keep the address to ${CUSTOM_PAGE_SLUG_MAX} characters or fewer.`;
  }
  if (!PAGE_SLUG_PATTERN.test(value)) {
    return 'Use lowercase letters, digits and single hyphens, like our-story.';
  }
  if (ROUTE.has(value) || RESERVED.has(value)) {
    return 'The site already uses this address. Choose another one.';
  }
  return null;
}

/** Whether a custom page may live at `/<value>`. */
export function isCustomPageSlug(value: unknown): value is string {
  return typeof value === 'string' && customPageSlugProblem(value) === null;
}

/**
 * The address the dialog suggests for an English title: lowercase words joined by hyphens,
 * anything else dropped, cut at a word inside the limit. May still be refused (a reserved
 * word, or no Latin letters at all), which the dialog then says.
 */
export function suggestPageSlug(title: string): string {
  const words = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
  let out = '';
  for (const word of words) {
    const next = out ? `${out}-${word}` : word;
    if (next.length > CUSTOM_PAGE_SLUG_MAX) break;
    out = next;
  }
  return out;
}

/**
 * The section types a custom page may hold: E10's blocks and the sections that bring their own
 * data and no route's (a heading hero, a call to action, the slogan, the social links, numbers,
 * quotes, client names, certifications). The rest belong to one page's design or need its
 * route's data (a form, the explorer, the project lists, the Join bands), so they are refused
 * on a custom page by the section routes and never rendered there.
 */
export const CUSTOM_PAGE_SECTION_TYPES = [
  'hero',
  'textBlock',
  'gallery',
  'video',
  'cta',
  'slogan',
  'social',
  'statistics',
  'testimonials',
  'clientsMarquee',
  'certifications',
] as const;

const CUSTOM_TYPES: ReadonlySet<string> = new Set(CUSTOM_PAGE_SECTION_TYPES);

export function isCustomPageSectionType(type: unknown): boolean {
  return typeof type === 'string' && CUSTOM_TYPES.has(type);
}

/** The words the section routes say when a type is refused on a custom page. */
export const CUSTOM_PAGE_TYPE_REFUSED =
  'This section is made for one of the site’s own pages, so a new page cannot hold it.';
