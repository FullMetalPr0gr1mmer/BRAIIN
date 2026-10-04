// Every public route the served-markup gates walk — EN, and its AR twin. One list, shared by
// tests/e2e/served-html.e2e.ts (CSP-clean markup, the brand) and share-image.e2e.ts (one
// usable og:image), so a route added for one gate is checked by both.
//
// Content routes point at SEEDED rows (local, CI, staging): the legacy demo rows are
// archived there, so naming one would scan the 404 page instead of the detail template.

export const PATHS = [
  '/',
  '/about',
  '/contact',
  '/services',
  // A live Round 2 service (the old /services/branding now answers a 301 that Playwright
  // would follow, and the scan would check the Services page twice instead).
  '/services/logo',
  '/portfolio',
  // UI v2 PR10 — the catalogue, plus a filtered view (its own response: private, same markup rules)
  '/portfolio/all',
  '/portfolio/all?service=logo',
  // A seeded published case study.
  '/portfolio/the-rider',
  '/creative-knowledge',
  '/creative-knowledge/arabic-first-brand-systems',
  '/search',
  // Join, plus a no-JS answer (?status= — its own response: private, same markup rules)
  '/join',
  '/join?status=ok',
  '/privacy',
  '/terms',
  '/cookie-policy',
  '/404',
] as const;

export const ROUTES: string[] = PATHS.flatMap((p) => [p, p === '/' ? '/ar' : `/ar${p}`]);

/** The AR twin's locale prefix. */
export const isArabic = (route: string): boolean => route === '/ar' || route.startsWith('/ar/');
