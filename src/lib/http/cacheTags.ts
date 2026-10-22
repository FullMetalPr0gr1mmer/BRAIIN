import type { Locale } from '@schemas/primitives';

// Tier-A response caching — ONE helper instead of the same two header lines copied into
// every public route (CLAUDE.md §2 render tiers; Cache-Tag scheme `tenant:<tid>`,
// `route:<name>`, `<entity>:<slug>`, `<entity>:all`, `locale:<en|ar>`).
//
// Every Tier-A page carries `site:identity` and `nav:all` as well as its own tags,
// because the header, footer and head of EVERY page render the public identity and the
// navigation: a brand or menu edit must be able to purge the whole site by two tags,
// not by enumerating routes. And `media:all` (Admin v2 R7): every page's head renders a URL
// built from a media row (the default share image, `seo_defaults.default_og_media`, through
// src/lib/seo/head.ts), so a media save, whose purge is `media:all`, must reach every page.

export const TIER_A_CACHE_CONTROL = 'public, s-maxage=31536000, stale-while-revalidate=86400';

/** Cloudflare purges at most 30 tags per request; one response never needs more. */
export const MAX_TAGS = 30;

/**
 * On every Tier A response: a collapsed purge (`tenant:default`), the identity, the menus, and
 * the media rows every head renders (the share image).
 */
export const ALWAYS_TAGS = ['tenant:default', 'site:identity', 'nav:all', 'media:all'] as const;
const ALWAYS = ALWAYS_TAGS;

type HasHeaders = { headers: Headers };

/**
 * A response's tags: the always tags, its route, its entities and its locale, each once. Past
 * 30, entities are dropped from the end but the always, route and locale tags are kept (a
 * dropped entity is still purged through `tenant:default`, the collapse every purge of more
 * than 30 tags uses); tests/lib/sectionReads.spec.ts holds every route's whole set within 30
 * so nothing is dropped in practice (Admin v2 R7).
 */
export function tierATags(opts: {
  route: string;
  locale: Locale;
  entities?: readonly string[];
}): string[] {
  const fixed = [...ALWAYS, `route:${opts.route}`, `locale:${opts.locale}`];
  const entities = [...new Set(opts.entities ?? [])].filter((tag) => !fixed.includes(tag));
  const room = Math.max(0, MAX_TAGS - fixed.length);
  return [...ALWAYS, `route:${opts.route}`, ...entities.slice(0, room), `locale:${opts.locale}`];
}

/** Long-lived edge cache, purged by tag on publish. */
export function setTierA(
  response: HasHeaders,
  opts: { route: string; locale: Locale; entities?: readonly string[] },
): void {
  response.headers.set('Cache-Control', TIER_A_CACHE_CONTROL);
  response.headers.set('Cache-Tag', tierATags(opts).join(','));
}

/**
 * A variant that must NOT be edge-cached — a filtered catalog URL, a form's `?status=`
 * echo. Only the canonical, unfiltered URL is Tier-A cached; caching every query-string
 * permutation would let anyone fill the cache with junk variants.
 */
export function noEdgeCache(response: HasHeaders): void {
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.delete('Cache-Tag');
}
