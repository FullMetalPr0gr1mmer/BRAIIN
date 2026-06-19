import type { APIRoute } from 'astro';
import { PUBLIC_SITE_URL } from 'astro:env/client';
import { getPublishedPosts } from '@/lib/data/blog';

// RSS 2.0 for the Creative Knowledge blog (EN). Regenerated on each request (cached);
// re-emits on publish. AR feed can be added at /ar/creative-knowledge/rss.xml later.
export const prerender = false;

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const GET: APIRoute = async () => {
  const base = PUBLIC_SITE_URL.replace(/\/$/, '');
  const posts = await getPublishedPosts();

  const items = posts
    .map((p) => {
      const title = esc(p.title.en ?? p.slug);
      const link = `${base}/creative-knowledge/${p.slug}`;
      const desc = esc(p.excerpt?.en ?? '');
      const pub = p.published_at ? new Date(p.published_at).toUTCString() : '';
      return (
        `    <item>\n` +
        `      <title>${title}</title>\n` +
        `      <link>${link}</link>\n` +
        `      <guid isPermaLink="true">${link}</guid>\n` +
        (pub ? `      <pubDate>${pub}</pubDate>\n` : '') +
        (desc ? `      <description>${desc}</description>\n` : '') +
        `    </item>`
      );
    })
    .join('\n');

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0">\n' +
    '  <channel>\n' +
    '    <title>Creative Knowledge — Braiin Station</title>\n' +
    `    <link>${base}/creative-knowledge</link>\n` +
    '    <description>Field notes on branding, motion, video, web, and SEO/GEO/AEO.</description>\n' +
    '    <language>en</language>\n' +
    (items ? items + '\n' : '') +
    '  </channel>\n' +
    '</rss>\n';

  return new Response(xml, {
    headers: {
      'content-type': 'application/rss+xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
};
