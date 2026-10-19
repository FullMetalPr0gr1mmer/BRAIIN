import type { Role } from '@/lib/auth/types';
import { mayRead } from './access';
import { isOnScreen } from './model';

// The page head's "Guide" (Admin v2 U16, the prototype's ROUTE_GUIDE): the one guide a
// screen opens straight from its head, beside the title. Known in code so the shell decides
// it with no read (P-15: an admin render reads nothing for help); the guides themselves stay
// in the database (migration 0046).
//
// Each entry copies what the set says of its guide: the capabilities it is for, and screens
// the guide names. tests/lib/helpCentre.spec.ts holds the copy to the set the migrations
// seed (the catalog, H11: the last restatement plus every put and drop since; the slug is there, the caps are the same, every screen is one the guide names, every
// screen a guide names has a page guide but the help page itself), so a migration that
// retires or retargets a guide fails CI until this list follows it.
//
// The button shows only for a role that may read the guide (`mayRead`, from ROLE_CAPS): SEO
// opens Pages without the content guide, which is for the roles that write content.

export interface PageGuide {
  slug: string;
  /** The guide's capabilities, as the set has them. */
  caps: readonly string[];
  /** The screens whose head offers it (a screen covers the pages below it). */
  screens: readonly string[];
}

export const PAGE_GUIDES: readonly PageGuide[] = [
  { slug: 'finding-your-way', caps: [], screens: ['/admin/search'] },
  { slug: 'your-dashboard', caps: [], screens: ['/admin'] },
  { slug: 'your-account', caps: [], screens: ['/admin/account', '/admin/notifications'] },
  { slug: 'roles-and-access', caps: [], screens: ['/admin/users'] },
  {
    slug: 'saving-and-publishing',
    caps: [
      'pages.write',
      'services.write',
      'portfolio.write',
      'blog.write',
      'nav.edit',
      'categories.manage',
    ],
    screens: [
      '/admin/pages',
      '/admin/sections',
      '/admin/services',
      '/admin/disciplines',
      '/admin/service-cases',
      '/admin/portfolio',
      '/admin/sectors',
      '/admin/blog',
      '/admin/categories',
      '/admin/navigation',
    ],
  },
  // Admin v2 U7: the collection screens and the FAQ (the guide is written as
  // docs/admin-v2/guides/collections-and-faq.json; H11's put seeds it).
  {
    slug: 'collections-and-faq',
    caps: ['pages.write', 'portfolio.write', 'blog.write', 'services.write'],
    screens: [
      '/admin/faq',
      '/admin/testimonials',
      '/admin/clients',
      '/admin/team',
      '/admin/statistics',
      '/admin/certifications',
    ],
  },
  { slug: 'media-library', caps: ['media.write'], screens: ['/admin/media'] },
  {
    slug: 'seo-and-redirects',
    caps: ['seo.globalDefaults', 'redirects.manage'],
    screens: ['/admin/seo', '/admin/redirects'],
  },
  { slug: 'working-with-leads', caps: ['leads.manage'], screens: ['/admin/leads'] },
  { slug: 'job-applications', caps: ['applications.manage'], screens: ['/admin/applications'] },
  { slug: 'maintenance-mode', caps: ['maintenance.manage'], screens: ['/admin/maintenance'] },
  { slug: 'page-visibility', caps: ['maintenance.manage'], screens: ['/admin/visibility'] },
  {
    slug: 'website-stats',
    caps: ['analytics.read'],
    screens: ['/admin/analytics', '/admin/analytics/search'],
  },
  {
    slug: 'site-health-and-logs',
    caps: ['siteHealth.view', 'logs.view', 'audit.view'],
    screens: ['/admin/site-health', '/admin/audit'],
  },
];

/**
 * The guide the head of this page offers this role, or null: the entry whose screen covers
 * the path most closely, when the role may read its guide.
 */
export function pageGuideFor(path: string, role: Role): string | null {
  let best: { guide: PageGuide; length: number } | null = null;
  for (const guide of PAGE_GUIDES) {
    for (const screen of guide.screens) {
      if (isOnScreen([screen], path) && (best === null || screen.length > best.length)) {
        best = { guide, length: screen.length };
      }
    }
  }
  return best && mayRead(role, best.guide.caps) ? best.guide.slug : null;
}
