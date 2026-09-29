import type { Locale } from '@schemas/primitives';
import { localizedHref } from '@/lib/i18n';
import { REDIRECT_CACHE_CONTROL } from '@/lib/http/redirects';

// Where the retired service URLs go (Round 2: 14 services regrouped into five disciplines
// holding 28). Every old `/services/<slug>` answers a 301 to its nearest new page, so no
// inbound link, bookmark or search result lands on a 404.
//
// Code-owned on purpose, and kept after Round 3 made the admin's `redirects` table reach
// the edge (owner decision G2: "restore wins" keeps holding). Precedence, plan R3-d:
//
//   live page  >  this map (route-level, services only)  >  the `redirects` table  >  404
//
// The service route consults this map ONLY when a slug misses, so restoring an archived
// service in the admin wins: its page renders again and this entry stops applying. The
// table is consulted by the middleware only after the render answered 404 — so it can
// never shadow a page either, and a rule authored for a retired slug simply never runs
// while this map answers it first (src/lib/http/redirects.ts, src/middleware.ts).
//
// The 301 carries the same `Cache-Control` as a table rule (REDIRECT_CACHE_CONTROL: one
// day) — not Tier A, never purged on publish, so a restore takes effect within a day at
// worst, and a browser that cached the hop longer is the visitor's cache, not ours.

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

/** The one lifetime every 30x on this site carries (shared with the table's rules). */
export const RETIRED_CACHE_CONTROL = REDIRECT_CACHE_CONTROL;

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
