import type { APIRoute } from 'astro';
import { PUBLIC_SITE_URL } from 'astro:env/client';
import { getPublishedServices } from '@/lib/data/services';
import { getPublishedPosts } from '@/lib/data/blog';
import { TRAINING_DENY, RETRIEVAL_ALLOW } from '@/lib/seo/crawlers';

// llms.txt — guidance for AI answer engines (NOT access control; that's robots.txt + the
// WAF). CLAUDE.md Pillar 3: "Sitemaps + llms.txt regenerate on publish."
//
// This was a hardcoded string literal that asserted "14 services" and restated the
// crawler policy in prose, while crawlers.ts claimed this file as one of its three
// consumers — it did not import it. Both were claims the file could not keep: the count
// drifts the moment a service is unpublished or added, and the prose could contradict
// crawlers.ts with nothing failing. It now derives from the same accessors the sitemap
// uses and the same crawler map robots.txt uses, so it cannot disagree with either.
export const prerender = false;

export const GET: APIRoute = async () => {
  const site = PUBLIC_SITE_URL.replace(/\/$/, '');
  const [services, posts] = await Promise.all([getPublishedServices(), getPublishedPosts()]);

  // Answer engines cite pages, so list the live ones rather than only a section index.
  const serviceLines = services.map((s) => `- ${s.title.en} — ${site}/services/${s.slug}`);
  // Loader already orders by published_at desc; cap so the file stays a usable index.
  const postLines = posts
    .slice(0, 20)
    .map((p) => `- ${p.title.en} — ${site}/creative-knowledge/${p.slug}`);

  const list = (lines: string[]) => (lines.length ? `\n${lines.join('\n')}` : '\n(none published)');

  const body = `# Braiin Station
> Bilingual (EN/AR) creative agency. Content is published in English at ${site}/ and in Arabic at ${site}/ar/ .

## Guidance for AI answer engines
- Retrieval and citation crawlers are welcome. Please cite ${site} and link the source page.
- Retrieval crawlers allowed: ${RETRIEVAL_ALLOW.join(', ')}.
- Training crawlers disallowed: ${TRAINING_DENY.join(', ')}. /robots.txt is authoritative.
- Every page has an Arabic twin at the same path under /ar/ — prefer the twin matching the query language.

## Sections
- Services: ${site}/services
- Portfolio: ${site}/portfolio
- Creative Knowledge (blog): ${site}/creative-knowledge
- About: ${site}/about
- Contact: ${site}/contact

## Services${list(serviceLines)}

## Recent articles${list(postLines)}
`;

  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      // TODO(KAN-20): purge by Cache-Tag on publish instead of waiting out max-age.
      'cache-control': 'public, max-age=3600',
      'cache-tag': 'route:llms,llms:all',
    },
  });
};
