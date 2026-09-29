import type { BilingualText, Locale } from '@schemas/primitives';
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
//
// One constraint on that "restore wins" rule: `canonicalServiceSlug` (below) converts the
// four RENAMED slugs at lead-save time unconditionally — it never reads the table — so a
// renamed slug must not be re-used as a service slug while the conversion window is open;
// remove the conversion with the window (the LEGACY_BUDGET_BANDS time-box,
// packages/schemas/lead.ts).

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
 * The old slugs that were RENAMED in place (Round 2 cut-over, `RENAMES` in
 * scripts/round2-cutover.mjs — tests/seed/cutover.spec.ts holds the two equal), each with
 * the title its row carried before the rename (verbatim from the last Round 1 seed): the
 * row kept its id and took the new slug and title, so neither the old slug nor the old
 * title exists in the table any more, and a lead's label needs the old title from here
 * ("الإنتاج المرئي (الآن …)", not a humanised English slug). The map above cannot tell
 * a rename from a merge on its own — `photography` also points at `/services/photo-video`,
 * but its row still exists, archived under its own title — so the rename set is named
 * here; the target still comes from the one map.
 */
export const RENAMED_SERVICE_SLUGS: Readonly<Record<string, BilingualText>> = Object.freeze({
  animations: { en: 'Animation', ar: 'الرسوم المتحركة' },
  videography: { en: 'Videography', ar: 'الإنتاج المرئي' },
  montage: { en: 'Montage', ar: 'المونتاج' },
  music: { en: 'Music', ar: 'الموسيقى' },
});

/**
 * The pre-Round-2 titles of the other retired slugs (archived, not renamed — verbatim from
 * the last Round 1 seed), for the "(retired)" lead label when the archived row cannot be
 * read. Together with the rename map this covers every key of RETIRED_SERVICES exactly
 * once (tests/lib/servicePage.spec.ts).
 */
export const RETIRED_SERVICE_TITLES: Readonly<Record<string, BilingualText>> = Object.freeze({
  branding: { en: 'Branding', ar: 'الهوية البصرية' },
  photography: { en: 'Photography', ar: 'التصوير الفوتوغرافي' },
  'event-planning': { en: 'Event Planning', ar: 'تنظيم الفعاليات' },
  'web-development': { en: 'Web Development', ar: 'تطوير المواقع' },
  merchandise: { en: 'Merchandise', ar: 'المنتجات الترويجية' },
  gaming: { en: 'Gaming', ar: 'الألعاب' },
});

/**
 * The slug an old service slug was renamed to (`videography` → `photo-video`), or null
 * for a slug that was archived, is live, or was never ours. Own-property lookup, as
 * `retiredTarget`.
 */
export function renamedServiceSlug(slug: string): string | null {
  if (!Object.hasOwn(RENAMED_SERVICE_SLUGS, slug) || !Object.hasOwn(RETIRED_SERVICES, slug)) {
    return null;
  }
  const match = /^\/services\/([a-z0-9-]+)$/.exec(RETIRED_SERVICES[slug] ?? '');
  return match?.[1] ?? null;
}

/**
 * The slug a lead's service interest is stored under: the renamed slug for the four
 * renames, else the slug as given. Cached pages (edge `s-maxage` of a year, no purge)
 * still post the old slugs — the same window LEGACY_BUDGET_BANDS covers
 * (packages/schemas/lead.ts); drop this with them once cached pages have turned over.
 * Unconditional (no table read on the lead insert), hence the re-use constraint in the
 * header: a renamed slug must not become a service slug again while this runs.
 */
export function canonicalServiceSlug(slug: string): string {
  return renamedServiceSlug(slug) ?? slug;
}

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
