import type { SeoRuleRow } from '@/lib/data/seo';
import { canonicalPath } from './canonical';
import { isNoindex } from './robots';
import type { SeoEntityType } from './entityPaths';
import { PAGE_PATHS } from '@/lib/visibility/routes';

// Which URLs the sitemap and llms.txt may offer (Admin v2 U10 D8; ui.md §5 "sitemap noindex
// exclusion"). A URL is left out when its effective robots says noindex (the page's own SEO
// row, else the site default, exactly as the head resolves it: resolveSeo's
// `entity.robots ?? defaults.robots_directives`), or when its canonical override names
// another path: listing a page that tells crawlers to index a different one contradicts it.
// Pure: src/pages/sitemap.xml.ts and llms.txt.ts read the rows (src/lib/data/seo.ts
// getSeoRules, getSeoDefaults) and filter with this, after page visibility's own filter.

export interface Indexability {
  /** The site default (seo_defaults.robots_directives) says noindex. */
  defaultNoindex: boolean;
  /** `<type>:<id>` → the SEO row's robots and canonical. */
  rules: ReadonlyMap<string, { robots: string | null; canonical: string | null }>;
  /** A published CMS page's id by its slug: a static route's SEO row is its page's. */
  pageIds: ReadonlyMap<string, string>;
}

/** Nothing known: every URL is listed (the behaviour before U10, and on a failed read). */
export const LIST_EVERYTHING: Indexability = {
  defaultNoindex: false,
  rules: new Map(),
  pageIds: new Map(),
};

export function indexability(
  read: { rules: SeoRuleRow[]; pages: { id: string; slug: string }[] } | null,
  defaultRobots: string | null | undefined,
): Indexability {
  return {
    defaultNoindex: isNoindex(defaultRobots),
    rules: new Map(
      (read?.rules ?? []).map((row) => [
        `${row.entity_type}:${row.entity_id}`,
        { robots: row.robots, canonical: row.canonical_override },
      ]),
    ),
    pageIds: new Map((read?.pages ?? []).map((page) => [page.slug, page.id])),
  };
}

/** The SEO target behind a static route's path (a CMS page), or null. */
function pageRefOf(ix: Indexability, path: string): { type: 'page'; id: string } | null {
  for (const [slug, pagePath] of Object.entries(PAGE_PATHS)) {
    if (pagePath !== path) continue;
    const id = ix.pageIds.get(slug);
    return id ? { type: 'page', id } : null;
  }
  return null;
}

/**
 * Whether `path` (logical) may be offered to crawlers. `ref` names its SEO target when the
 * caller knows it (a service, project or post by id); a static route finds its page's.
 */
export function isIndexedPath(
  ix: Indexability,
  path: string,
  base: string,
  ref?: { type: SeoEntityType; id: string } | null,
): boolean {
  const target = ref ?? pageRefOf(ix, path);
  const rule = target ? ix.rules.get(`${target.type}:${target.id}`) : undefined;
  const robots = rule?.robots ?? null;
  if (robots !== null ? isNoindex(robots) : ix.defaultNoindex) return false;
  const canonical = canonicalPath(rule?.canonical, base);
  return canonical === null || canonical === path;
}
