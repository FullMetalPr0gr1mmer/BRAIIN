import type { APIRoute } from 'astro';
import { PUBLIC_SITE_URL } from 'astro:env/client';
import { localizedPath } from '@/lib/i18n';
import { getPublishedServices } from '@/lib/data/services';

// Bilingual sitemap with reciprocal hreflang. Phase 0 lists the static routes; in
// later phases CMS content is appended on publish with accurate <lastmod>.
export const prerender = false;

const STATIC_PATHS = ['/', '/services', '/privacy', '/terms', '/cookie-policy'];

export const GET: APIRoute = async () => {
  const base = PUBLIC_SITE_URL.replace(/\/$/, '');
  const services = await getPublishedServices();
  const logicalPaths = [...STATIC_PATHS, ...services.map((s) => `/services/${s.slug}`)];

  const urls = logicalPaths.flatMap((p) =>
    (['en', 'ar'] as const).map((loc) => {
      const loc_href = base + localizedPath(p, loc);
      const alts = (['en', 'ar', 'x-default'] as const)
        .map((h) => {
          const target = h === 'x-default' ? 'en' : h;
          return `<xhtml:link rel="alternate" hreflang="${h}" href="${base + localizedPath(p, target)}"/>`;
        })
        .join('');
      return `  <url><loc>${loc_href}</loc>${alts}</url>`;
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
      'cache-control': 'public, max-age=3600',
    },
  });
};
