import type { SearchHit } from '@schemas/search';
import { toLogicalPath } from '@/lib/i18n';
import { hasRestrictions, isListed, type VisibilitySnapshot } from '@/lib/http/visibility';
import { targetForPath } from './routes';

// What leaves the public lists when a page is not public (Admin v2 U14a): the header and
// footer menus, the sitemap, llms.txt and the search results. Only a PUBLIC page is listed;
// link only is unlisted (its link still works) and hidden is gone. The readers get the
// request's snapshot from `locals.visibility` (the middleware's read, memoised per isolate)
// and compare with the request's time, so a hidden window opens and closes with no cron.
//
// With no restriction in the snapshot every function here returns its input as it came
// (the same array, in the same order): Tier A HTML is byte-identical while nothing is hidden,
// which tests/render/siteChrome.spec.ts and the public e2e hold.

/**
 * The logical path of a site-relative href (`/ar/about?x#y` → `/about`), or null for one
 * that is not a page of this site: an absolute URL, `mailto:`, a bare `#anchor`, `//host`.
 */
export function logicalPathOfHref(href: string): string | null {
  if (!href.startsWith('/') || href.startsWith('//') || href.startsWith('/\\')) return null;
  const cut = href.search(/[?#]/);
  const path = cut === -1 ? href : href.slice(0, cut);
  return toLogicalPath(path || '/');
}

/** Whether a logical path is listed at `now` (a path no page owns always is). */
export function isListedPath(
  snapshot: VisibilitySnapshot | null | undefined,
  logicalPath: string,
  now: number,
): boolean {
  return isListed(snapshot, targetForPath(logicalPath), now);
}

interface NavLike {
  href: string;
  children: NavLike[];
}

/**
 * The menu without the items that point at a page that is not listed (a hidden or link-only
 * page, or a child of a hidden template). A removed item takes its children with it: they
 * sit under it in the menu, and a child left without its group would read as a stray link.
 */
export function filterNavForVisibility<T extends NavLike>(
  nodes: T[],
  snapshot: VisibilitySnapshot | null | undefined,
  now: number,
): T[] {
  if (!hasRestrictions(snapshot)) return nodes;
  const keep = (node: NavLike): boolean => {
    const path = logicalPathOfHref(node.href);
    return path === null || isListedPath(snapshot, path, now);
  };
  return nodes
    .filter(keep)
    .map((node) => ({ ...node, children: filterNavForVisibility(node.children, snapshot, now) }));
}

/** The page each kind of search hit opens. */
const HIT_PATH: Readonly<Record<SearchHit['entity_type'], string>> = {
  service: '/services/',
  portfolio: '/portfolio/',
  blog: '/creative-knowledge/',
};

/** The public search's hits a visitor may be shown: none under a hidden template. */
export function listedSearchHits(
  hits: SearchHit[],
  snapshot: VisibilitySnapshot | null | undefined,
  now: number,
): SearchHit[] {
  if (!hasRestrictions(snapshot)) return hits;
  return hits.filter((hit) =>
    isListedPath(snapshot, `${HIT_PATH[hit.entity_type]}${hit.slug}`, now),
  );
}
