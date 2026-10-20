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
  {
    slug: 'your-account',
    caps: [],
    // /admin/2fa (U17): the two factor page, a full session's setup and management.
    screens: ['/admin/account', '/admin/notifications', '/admin/2fa'],
  },
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
      '/admin/testimonials',
      '/admin/clients',
      '/admin/team',
      '/admin/statistics',
      '/admin/certifications',
      '/admin/navigation',
    ],
  },
  { slug: 'media-library', caps: ['media.write'], screens: ['/admin/media'] },
  {
    slug: 'seo-and-redirects',
    caps: ['seo.globalDefaults', 'redirects.manage'],
    screens: ['/admin/seo', '/admin/redirects'],
  },
  { slug: 'working-with-leads', caps: ['leads.manage'], screens: ['/admin/leads'] },
  // Admin v2 C9a: its guide is put by 0091 (H11's catalog).
  { slug: 'crm-settings', caps: ['crm.settings'], screens: ['/admin/crm/settings'] },
  { slug: 'job-applications', caps: ['applications.manage'], screens: ['/admin/applications'] },
  { slug: 'general-settings', caps: ['settings.general'], screens: ['/admin/settings'] },
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
  {
    // R9: the roles that may preview (PREVIEW_READ_CAPS; tests/lib/previewGuide.spec.ts).
    slug: 'previewing-changes',
    caps: [
      'blog.write',
      'categories.manage',
      'maintenance.manage',
      'nav.edit',
      'pages.write',
      'portfolio.write',
      'redirects.manage',
      'seo.entityMeta',
      'seo.globalDefaults',
      'services.write',
      'settings.general',
      'theme.edit',
    ],
    screens: ['/admin/preview'],
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
