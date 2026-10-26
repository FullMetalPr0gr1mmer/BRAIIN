import { GA4_NOTICE_READY } from 'astro:env/server';

// Google Analytics 4 on the public site (Admin v2 U15): whether a request reads the
// measurement id, and so whether its page may load GA4 at all. CLAUDE.md §2 keeps GA4
// secondary (the first-party analytics are the numbers of record, never double-written),
// §7 puts it behind the one consent gate, and the privacy notice must name Google before it
// loads anywhere (the switch below).
//
// Three conditions, all needed, decided by src/middleware.ts BEFORE the render:
//   1. the switch: GA4_NOTICE_READY (astro:env, default off; tests mock ga4NoticeReady());
//   2. the request: a GET or HEAD of a public page route listed below, answered publicly (a
//      page unlocked by its password or seen past the maintenance page is private, and never
//      loads it; nor does a preview, whose branch returns before this is asked);
//   3. the data: an id saved on /admin/integrations, read once (src/lib/data/ga4.ts).
// With the switch off nothing is read and nothing changes, byte for byte. With all three,
// the layout renders the same-origin loader (src/components/Ga4Loader.astro) and the
// response's CSP gains Google's hosts (GA4_CSP_SOURCES in securityHeaders.ts). The loader
// then waits for analytics consent before anything from Google loads.

/** The code-owned switch: the owner has signed off the notice that names Google. */
export function ga4NoticeReady(): boolean {
  return GA4_NOTICE_READY === true;
}

/** The same-origin loader (public/scripts/ga4.js): a static file, `script-src 'self'`. */
export const GA4_LOADER_SRC = '/scripts/ga4.js';

/**
 * The public page routes that load GA4, by the route Astro matched (`context.routePattern`),
 * English first and each Arabic twin under /ar. Every public page but these:
 *   - /search: its address and its box carry what a visitor typed, which Google is not sent
 *     (the first-party search log keeps the counts);
 *   - /join: the application form, an applicant's contact details and CV (Admin only in both
 *     server layers, CLAUDE.md §3): Google's script never runs beside it;
 *   - the 404 pages and the /ar catch-all: nothing to measure.
 * The lead form is not a reason on its own: it is on Home, Services, every service page and
 * Contact, so GA4 runs beside it with the property's form interactions OFF (launch runbook
 * §2e) and nothing typed is ever sent (U15's as-built, a residual the owner signs off with the
 * notice). tests/lib/ga4Routes.spec.ts holds this list to the files in src/pages: a new page
 * needs a decision either way, and a page that renders the application form is never listed.
 */
const EN_ROUTES = [
  '/',
  '/about',
  '/contact',
  '/services',
  '/services/[slug]',
  '/portfolio',
  '/portfolio/all',
  '/portfolio/[slug]',
  '/creative-knowledge',
  '/creative-knowledge/[slug]',
  '/privacy',
  '/terms',
  '/cookie-policy',
] as const;

const arabic = (route: string): string => (route === '/' ? '/ar' : `/ar${route}`);

export const GA4_ROUTES: ReadonlySet<string> = new Set([...EN_ROUTES, ...EN_ROUTES.map(arabic)]);

/** The public page routes that never load GA4, and why (held to src/pages with the list above). */
export const NOT_GA4_ROUTES: Readonly<Record<string, string>> = {
  '/search': 'what a visitor typed is in its address',
  '/ar/search': 'what a visitor typed is in its address',
  '/join': "the application form: an applicant's contact details and CV (Admin-only PII)",
  '/ar/join': "the application form: an applicant's contact details and CV (Admin-only PII)",
  '/404': 'nothing to measure',
  '/ar/404': 'nothing to measure',
  '/ar/[...path]': 'the Arabic catch-all, which answers the Arabic 404 page',
};

const READ_METHODS = new Set(['GET', 'HEAD']);

export interface Ga4Request {
  method: string;
  /** The route Astro matched (`context.routePattern`). */
  routePattern: string | null | undefined;
  /** An admin, API, health or image request: never a public page. */
  internal: boolean;
  /** Answered privately: a page unlocked by its password, or seen past the maintenance page. */
  private: boolean;
}

/** True when this request reads the id (and its page may load GA4): the switch, then the request. */
export function ga4Reads(request: Ga4Request): boolean {
  if (!ga4NoticeReady()) return false;
  if (request.internal || request.private) return false;
  if (!READ_METHODS.has(request.method)) return false;
  return Boolean(request.routePattern && GA4_ROUTES.has(request.routePattern));
}
