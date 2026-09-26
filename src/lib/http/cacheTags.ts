import type { Locale } from '@schemas/primitives';

// Tier-A response caching — ONE helper instead of the same two header lines copied into
// every public route (CLAUDE.md §2 render tiers; Cache-Tag scheme `tenant:<tid>`,
// `route:<name>`, `<entity>:<slug>`, `<entity>:all`, `locale:<en|ar>`).
//
// Every Tier-A page carries `site:identity` and `nav:all` as well as its own tags,
// because the header, footer and head of EVERY page render the public identity and the
// navigation: a brand or menu edit must be able to purge the whole site by two tags,
// not by enumerating routes.

export const TIER_A_CACHE_CONTROL = 'public, s-maxage=31536000, stale-while-revalidate=86400';

/** Cloudflare purges at most 30 tags per request; one response never needs more. */
const MAX_TAGS = 30;

const ALWAYS = ['tenant:default', 'site:identity', 'nav:all'] as const;

type HasHeaders = { headers: Headers };

export function tierATags(opts: {
  route: string;
  locale: Locale;
  entities?: readonly string[];
}): string[] {
  const tags = [
    ...ALWAYS,
    `route:${opts.route}`,
    ...(opts.entities ?? []),
    `locale:${opts.locale}`,
  ];
  return [...new Set(tags)].slice(0, MAX_TAGS);
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
