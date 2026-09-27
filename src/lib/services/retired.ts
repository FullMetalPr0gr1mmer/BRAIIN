import type { Locale } from '@schemas/primitives';
import { localizedHref } from '@/lib/i18n';

// Where the retired service URLs go (Round 2: 14 services regrouped into five disciplines
// holding 28). Every old `/services/<slug>` answers a 301 to its nearest new page, so no
// inbound link, bookmark or search result lands on a 404.
//
// Code-owned, not the `redirects` table: that module never takes effect today (middleware
// reads KV `site:redirects` and nothing writes it — a pre-existing gap, plan "Redirects
// for retired slugs"). The map is consulted ONLY when a slug misses, so restoring an
// archived service in the admin wins: its page renders again and this entry stops applying.
//
// The 301 carries an explicit `Cache-Control: public, max-age=86400` — it is not Tier A
// (never purged on publish), so a restore takes effect within a day at worst.

/** Old slug → the logical path (locale-free) it now lives at. */
export const RETIRED_SERVICES: Readonly<Record<string, string>> = Object.freeze({
  branding: '/services#branding',
  animations: '/services/animation',
  videography: '/services/photo-video',
  photography: '/services/photo-video',
  montage: '/services/video-editing',
  'event-planning': '/services#events',
  'web-development': '/services#web',
  music: '/services/music-vo-sfx',
  merchandise: '/services#branding',
  gaming: '/services',
});

export const RETIRED_CACHE_CONTROL = 'public, max-age=86400';

/**
 * The page a retired slug moved to, in the visitor's language (`/ar/services#branding`),
 * or null for a slug that was never ours. An own-property lookup: `constructor`,
 * `__proto__` or `toString` in a URL must not resolve to something on Object.prototype.
 */
export function retiredTarget(slug: string, locale: Locale): string | null {
  if (!Object.hasOwn(RETIRED_SERVICES, slug)) return null;
  const target = RETIRED_SERVICES[slug];
  return target ? localizedHref(target, locale) : null;
}

/** The permanent redirect for a retired slug, or null. */
export function retiredRedirect(slug: string, locale: Locale): Response | null {
  const location = retiredTarget(slug, locale);
  if (!location) return null;
  return new Response(null, {
    status: 301,
    headers: { Location: location, 'Cache-Control': RETIRED_CACHE_CONTROL },
  });
}
