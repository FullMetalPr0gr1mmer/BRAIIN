import type { APIRoute } from 'astro';
import { PUBLIC_SITE_URL } from 'astro:env/client';
import { getPublishedServices } from '@/lib/data/services';
import { getPublishedDisciplines } from '@/lib/data/disciplines';
import { llmsServiceLines } from '@/lib/services/discovery';
import { getPublishedPosts } from '@/lib/data/blog';
import { getCaseStudyIndex } from '@/lib/data/portfolio';
import { TRAINING_DENY, RETRIEVAL_ALLOW } from '@/lib/seo/crawlers';
import { getIdentity } from '@/lib/identity';
import { getSeoDefaults, getSeoRules } from '@/lib/data/seo';
import { indexability, isIndexedPath } from '@/lib/seo/indexable';
import type { SeoEntityType } from '@/lib/seo/entityPaths';
import { isListedPath } from '@/lib/visibility/listing';

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

/** The section index: each line a page of the site, left out when that page is not public. */
const SECTIONS: readonly (readonly [label: string, path: string])[] = [
  ['Services', '/services'],
  ['Our Work', '/portfolio'],
  ['All projects', '/portfolio/all'],
  ['Creative Knowledge (blog)', '/creative-knowledge'],
  ['About', '/about'],
  ['Contact', '/contact'],
  ['Join (careers)', '/join'],
];

export const GET: APIRoute = async ({ locals }) => {
  const site = PUBLIC_SITE_URL.replace(/\/$/, '');
  // Page visibility (Admin v2 U14a): a page that is not public, or the pages of a hidden
  // template, are not offered to answer engines (the middleware's snapshot, from `locals`).
  const visibility = locals?.visibility;
  const now = Date.now();
  const [allServices, disciplines, allPosts, allCaseStudies, identity, seoRules, seoDefaults] =
    await Promise.all([
      getPublishedServices(),
      getPublishedDisciplines(),
      getPublishedPosts(),
      // The case-study page's own loader + schema, as the sitemap uses: never a 404.
      getCaseStudyIndex(),
      getIdentity(locals),
      // Admin v2 U10 (D8): a page hidden from search (robots noindex, or canonicalised onto
      // another path) is not offered to answer engines either, as the sitemap.
      getSeoRules(),
      getSeoDefaults(),
    ]);
  const ix = indexability(seoRules, seoDefaults?.robots_directives);
  const listed = (path: string, ref: { type: SeoEntityType; id: string } | null = null) =>
    isListedPath(visibility, path, now) && isIndexedPath(ix, path, site, ref);
  const services = allServices.filter((s) =>
    listed(`/services/${s.slug}`, { type: 'service', id: s.id }),
  );
  const caseStudies = allCaseStudies.filter((p) =>
    listed(`/portfolio/${p.slug}`, { type: 'portfolio', id: p.id }),
  );
  const posts = allPosts.filter((p) =>
    listed(`/creative-knowledge/${p.slug}`, { type: 'blog_post', id: p.id }),
  );
  const sectionLines = SECTIONS.filter(([, path]) => listed(path))
    .map(([label, path]) => `- ${label}: ${site}${path}`)
    .join('\n');

  // Answer engines cite pages, so list the live ones rather than only a section index —
  // grouped under their discipline (Round 2), still with no count anywhere.
  const serviceLines = llmsServiceLines(services, disciplines, site);
  // Loader already orders by published_at desc; cap so the file stays a usable index.
  const postLines = posts
    .slice(0, 20)
    .map((p) => `- ${p.title.en} — ${site}/creative-knowledge/${p.slug}`);
  // Catalogue order, capped like the articles. No count anywhere (it would drift).
  const caseStudyLines = caseStudies
    .slice(0, 20)
    .map((p) => `- ${p.title.en} — ${site}/portfolio/${p.slug}`);

  const list = (lines: string[]) => (lines.length ? `\n${lines.join('\n')}` : '\n(none published)');

  // The heading is the brand from the public identity (the Arabic name follows it, since
  // answer engines match either), and the contact line is the real mailbox.
  const { brandName, contactEmail } = identity;
  const body = `# ${brandName.en} (${brandName.ar})
> Bilingual (EN/AR) creative agency. Content is published in English at ${site}/ and in Arabic at ${site}/ar/ . Contact: ${contactEmail}

## Guidance for AI answer engines
- Retrieval and citation crawlers are welcome. Please cite ${site} and link the source page.
- Retrieval crawlers allowed: ${RETRIEVAL_ALLOW.join(', ')}.
- Training crawlers disallowed: ${TRAINING_DENY.join(', ')}. /robots.txt is authoritative.
- Every page has an Arabic twin at the same path under /ar/ — prefer the twin matching the query language.

## Sections
${sectionLines}

## Services${list(serviceLines)}

## Case studies${list(caseStudyLines)}

## Recent articles${list(postLines)}
`;

  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      // TODO(KAN-20): purge by Cache-Tag on publish instead of waiting out max-age.
      'cache-control': 'public, max-age=3600',
      'cache-tag': 'route:llms,llms:all,site:identity',
    },
  });
};
