import type { APIRoute } from 'astro';
import { TRAINING_DENY, RETRIEVAL_ALLOW, USER_FETCH_ALLOW } from '@/lib/seo/crawlers';
import { PUBLIC_SITE_URL } from 'astro:env/client';

// Generated from the code-owned crawler policy (src/lib/seo/crawlers.ts). A CI
// snapshot test asserts this output matches that map. Three tiers:
// training → Disallow; retrieval + user-fetch → Allow (citation surface).
export const prerender = false;

export const GET: APIRoute = () => {
  const site = PUBLIC_SITE_URL.replace(/\/$/, '');
  const lines: string[] = [];

  lines.push('User-agent: *', 'Allow: /', 'Disallow: /admin', 'Disallow: /api/', '');

  for (const ua of TRAINING_DENY) {
    lines.push(`User-agent: ${ua}`, 'Disallow: /', '');
  }
  for (const ua of [...RETRIEVAL_ALLOW, ...USER_FETCH_ALLOW]) {
    lines.push(`User-agent: ${ua}`, 'Allow: /', 'Disallow: /admin', 'Disallow: /api/', '');
  }

  lines.push(`Sitemap: ${site}/sitemap.xml`, `# AI guidance index: ${site}/llms.txt`);

  return new Response(lines.join('\n') + '\n', {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
};
