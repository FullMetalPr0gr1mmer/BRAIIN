import type { APIRoute } from 'astro';
import { SITEMAP_CACHE_TAG } from '@/lib/http/routeTags';
import { PUBLIC_SITE_URL } from 'astro:env/client';
import { localizedPath } from '@/lib/i18n';
import { getPublishedServices } from '@/lib/data/services';
import { getCaseStudyIndex } from '@/lib/data/portfolio';
import { getPublishedPosts } from '@/lib/data/blog';
import { getSeoDefaults, getSeoRules } from '@/lib/data/seo';
import { indexability, isIndexedPath } from '@/lib/seo/indexable';
import type { SeoEntityType } from '@/lib/seo/entityPaths';
import { isListedPath } from '@/lib/visibility/listing';

// Bilingual sitemap with reciprocal hreflang + truthful <lastmod> (CLAUDE.md Pillar 3).
//
// `lastmod` comes from the row's `updated_at` and is OMITTED when the row has none.
// Emitting `new Date()` — the tempting alternative — would tell crawlers every URL
// changed on every fetch, which is worse than saying nothing: it burns crawl budget and
// teaches Google to distrust the signal. Static routes have no row, so they carry no
// lastmod rather than a fabricated one.
export const prerender = false;

const STATIC_PATHS = [
  '/',
  '/services',
  '/portfolio',
  // UI v2 PR10. Its filtered views (?service=…) are never listed: each is canonicalised to
  // the bare page and served uncached, so a sitemap entry would contradict both.
  '/portfolio/all',
  '/about',
  '/creative-knowledge',
  '/contact',
  // Join: the bare page only — its `?status=` answers are private and canonicalised to it.
  '/join',
  '/privacy',
  '/terms',
  '/cookie-policy',
];

/** W3C-datetime, the only format sitemaps.org allows. Invalid input → omit. */
function lastmod(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `<lastmod>${d.toISOString().slice(0, 10)}</lastmod>`;
}

export const GET: APIRoute = async (context) => {
  const base = PUBLIC_SITE_URL.replace(/\/$/, '');
  // Page visibility (Admin v2 U14a): only a public page is listed, never a link-only or a
  // hidden one, nor the children of a hidden template. The snapshot is the middleware's
  // (`locals`); a crawler's copy may list a page up to an hour after it is hidden (max-age).
  const visibility = context?.locals?.visibility;
  const now = Date.now();
  const [services, portfolio, posts, seoRules, seoDefaults] = await Promise.all([
    getPublishedServices(),
    // The case-study page's own loader + schema (never a URL the page would 404 on).
    getCaseStudyIndex(),
    getPublishedPosts(),
    // Admin v2 U10 (D8): what leaves a URL out for crawlers, read in the same round.
    getSeoRules(),
    getSeoDefaults(),
  ]);
  const ix = indexability(seoRules, seoDefaults?.robots_directives);

  type Entry = {
    path: string;
    updated: string | null;
    ref?: { type: SeoEntityType; id: string };
  };
  const all: Entry[] = [
    ...STATIC_PATHS.map((path) => ({ path, updated: null })),
    // Every PUBLISHED service — the rule its page answers 200 by (status + RLS, which also
    // hides one whose discipline is unpublished). Round 1’s retired slugs are
    // archived, so they are never listed: those URLs answer a 301 (src/lib/services/retired.ts).
    ...services.map((s) => ({
      path: `/services/${s.slug}`,
      updated: s.updated_at,
      ref: { type: 'service' as const, id: s.id },
    })),
    ...portfolio.map((p) => ({
      path: `/portfolio/${p.slug}`,
      updated: p.updatedAt,
      ref: { type: 'portfolio' as const, id: p.id },
    })),
    ...posts.map((p) => ({
      path: `/creative-knowledge/${p.slug}`,
      updated: p.updated_at,
      ref: { type: 'blog_post' as const, id: p.id },
    })),
  ];
  // Page visibility first (U14a), then indexability (U10): a page hidden from search by its
  // robots, or canonicalised onto another path, is not offered either.
  const entries = all.filter(
    ({ path, ref }) =>
      isListedPath(visibility, path, now) && isIndexedPath(ix, path, base, ref ?? null),
  );

  const urls = entries.flatMap(({ path, updated }) =>
    (['en', 'ar'] as const).map((loc) => {
      const loc_href = base + localizedPath(path, loc);
      const alts = (['en', 'ar', 'x-default'] as const)
        .map((h) => {
          const target = h === 'x-default' ? 'en' : h;
          return `<xhtml:link rel="alternate" hreflang="${h}" href="${base + localizedPath(path, target)}"/>`;
        })
        .join('');
      return `  <url><loc>${loc_href}</loc>${lastmod(updated)}${alts}</url>`;
    }),
  );

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
    urls.join('\n') +
    '\n</urlset>\n';

  return new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      // TODO(KAN-20): swap max-age for a Cache-Tag purge on publish so the sitemap
      // reflects a publish immediately instead of lagging up to an hour.
      'cache-control': 'public, max-age=3600',
      'cache-tag': SITEMAP_CACHE_TAG,
    },
  });
};
