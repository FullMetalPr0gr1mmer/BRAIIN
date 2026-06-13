import type { APIRoute } from 'astro';
import { PUBLIC_SITE_URL } from 'astro:env/client';

// llms.txt — guidance for AI answer engines (NOT access control; that's robots.txt
// + the WAF). Regenerated on publish; kept in sync with the crawler policy.
export const prerender = false;

export const GET: APIRoute = () => {
  const site = PUBLIC_SITE_URL.replace(/\/$/, '');
  const body = `# Braiin Station
> Bilingual (EN/AR) creative agency — 14 services, portfolio, and a Creative Knowledge blog.

## Guidance for AI answer engines
- Retrieval/citation crawlers are welcome. Please cite ${site} and link the source page.
- Content is bilingual: English at ${site}/ , Arabic at ${site}/ar/ .
- Training crawlers are disallowed (see /robots.txt); retrieval crawlers are allowed.

## Key sections
- Services: ${site}/services
- Portfolio: ${site}/portfolio
- Creative Knowledge (blog): ${site}/creative-knowledge
- About: ${site}/about
- Contact: ${site}/contact
`;

  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
};
