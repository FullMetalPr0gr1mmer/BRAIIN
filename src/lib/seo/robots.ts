import { SEO_ROBOTS } from '@schemas/admin';

// Robots values, read leniently and written strictly (Admin v2 U10 D5). The write schemas
// take only the closed sets in packages/schemas/admin.ts; production may still hold free text
// written before them, so a stored value is read here: anything naming `noindex` hides the
// page, as SeoHead has always decided (`robots.includes('noindex')`).

export type PageRobots = (typeof SEO_ROBOTS)[number];

/** True when a stored robots value keeps the page out of search results. */
export function isNoindex(robots: string | null | undefined): boolean {
  return typeof robots === 'string' && robots.toLowerCase().includes('noindex');
}

/**
 * A stored per-page value as the closed set the editor writes: null (follow the site
 * default) stays null, a value naming noindex is `noindex,follow`, anything else written is
 * `index,follow`. So a legacy `noindex, nofollow` is shown and saved back as noindex.
 */
export function pageRobots(robots: string | null | undefined): PageRobots | null {
  if (robots === null || robots === undefined || robots.trim() === '') return null;
  return isNoindex(robots) ? 'noindex,follow' : 'index,follow';
}
