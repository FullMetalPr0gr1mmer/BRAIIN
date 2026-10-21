import { CONTACT_CACHE_ENTITIES } from '@/lib/sections/contact';
import { HOME_CACHE_ENTITIES } from '@/lib/sections/home';
import { JOIN_CACHE_ENTITIES } from '@/lib/sections/join';
import { serviceCacheEntities } from '@/lib/services/page';
import { SERVICES_CACHE_ENTITIES } from '@/lib/services/servicesPage';

// Every Tier A route's own Cache-Tag entities, in one table (Admin v2 R7): what each page
// renders whatever its sections, before `sectionTags` adds what its composed sections read
// (src/lib/sections/reads.ts). The lists that already lived beside their routes' loaders
// (home, services, a service, contact, join) are named here; the ones that lived in the .astro
// files (About, Our Work, All projects, a case study) moved here, `media:all` added: those
// pages show posters and images, and a media alt or tag save purges `media:all` (README, "What
// the mapping found"). tests/lib/sectionReads.spec.ts walks this table: every route within 30
// tags with every section a composed page could hold, and every tag a release or a media save
// purges stamped by at least one route.

export const ABOUT_CACHE_ENTITIES = [
  'page:about',
  'team:all',
  'statistics:all',
  'media:all',
] as const;

export const WORK_CACHE_ENTITIES = [
  'page:portfolio',
  'portfolio:all',
  'sectors:all',
  'clients:all',
  'services:all',
  'statistics:all',
  'testimonials:all',
  'media:all',
] as const;

export const ALL_PROJECTS_CACHE_ENTITIES = [
  'page:portfolio-all',
  'portfolio:all',
  'sectors:all',
  'clients:all',
  'services:all',
  'media:all',
] as const;

/** A case study: its project, the next project's card, its sector, client, services, quote. */
export function caseStudyCacheEntities(slug: string): string[] {
  return [
    `portfolio:${slug}`,
    'portfolio:all',
    'sectors:all',
    'clients:all',
    'services:all',
    'testimonials:all',
    'media:all',
  ];
}

export interface TierARoute {
  /** The `route:<name>` tag. */
  route: string;
  /** Its own entities (a parametric one with a sample slug). */
  entities: readonly string[];
  /** A page composed from CMS sections: it also stamps what its sections read. */
  composed: boolean;
}

/** Every Tier A route, both locales stamping the same set. */
export const TIER_A_ROUTES: readonly TierARoute[] = [
  { route: 'home', entities: HOME_CACHE_ENTITIES, composed: true },
  { route: 'about', entities: ABOUT_CACHE_ENTITIES, composed: true },
  { route: 'services', entities: SERVICES_CACHE_ENTITIES, composed: true },
  { route: 'service', entities: serviceCacheEntities('sample'), composed: false },
  { route: 'portfolio', entities: WORK_CACHE_ENTITIES, composed: true },
  { route: 'portfolio-all', entities: ALL_PROJECTS_CACHE_ENTITIES, composed: true },
  { route: 'portfolio-item', entities: caseStudyCacheEntities('sample'), composed: false },
  { route: 'contact', entities: CONTACT_CACHE_ENTITIES, composed: true },
  { route: 'join', entities: JOIN_CACHE_ENTITIES, composed: true },
  { route: 'blog', entities: ['blog:all'], composed: false },
  { route: 'blog-post', entities: ['blog:sample'], composed: false },
  { route: 'search', entities: [], composed: false },
  { route: 'legal', entities: [], composed: false },
];

/** The sitemap's and llms.txt's tags: their routes, a collapsed purge, and what they list. */
export const SITEMAP_CACHE_TAG = 'tenant:default,route:sitemap,sitemap:all';
export const LLMS_CACHE_TAG = 'tenant:default,route:llms,llms:all,site:identity';
