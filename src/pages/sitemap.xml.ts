import type { APIRoute } from 'astro';
import { PUBLIC_SITE_URL } from 'astro:env/client';
import { localizedPath } from '@/lib/i18n';
import { getPublishedServices } from '@/lib/data/services';
import { getPublishedPortfolio } from '@/lib/data/portfolio';
import { getPublishedPosts } from '@/lib/data/blog';

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
  '/about',
  '/creative-knowledge',
  '/contact',
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

export const GET: APIRoute = async () => {
  const base = PUBLIC_SITE_URL.replace(/\/$/, '');
  const [services, portfolio, posts] = await Promise.all([
    getPublishedServices(),
    getPublishedPortfolio(),
    getPublishedPosts(),
  ]);

  const entries: { path: string; updated: string | null }[] = [
    ...STATIC_PATHS.map((path) => ({ path, updated: null })),
    ...services.map((s) => ({ path: `/services/${s.slug}`, updated: s.updated_at })),
    ...portfolio.map((p) => ({ path: `/portfolio/${p.slug}`, updated: p.updated_at })),
    ...posts.map((p) => ({ path: `/creative-knowledge/${p.slug}`, updated: p.updated_at })),
  ];

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
      'cache-tag': 'route:sitemap,sitemap:all',
    },
  });
};
