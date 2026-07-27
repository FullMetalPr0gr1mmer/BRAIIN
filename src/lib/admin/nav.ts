import type { Role } from '@/lib/auth/types';
import { ROLE_CAPS, type Access, type Capability } from '@/lib/authz/matrix';

// The admin sidebar, derived from the SAME ROLE_CAPS map the server enforces.
//
// This is UX ONLY. CLAUDE.md is explicit that `can()` in the UI is never a security
// control, and nothing here is: hiding a link does not protect the endpoint behind it,
// and every one of those endpoints re-derives the answer through assertCap() plus RLS.
//
// What it buys is honesty — a Content Creator who never sees a "Leads" link never
// discovers the boundary by clicking it and getting a 403. Deriving the menu from
// ROLE_CAPS rather than hand-listing it per role is what keeps the two in step: a
// capability moved in CLAUDE.md §5 moves the menu item with it, and there is no second
// list to forget.

export interface NavLink {
  href: string;
  label: string;
  /** Visible when the role holds ANY of these at `access`. */
  caps: readonly Capability[];
  access?: readonly Access[];
}

export interface NavGroup {
  title: string;
  links: readonly NavLink[];
}

export const ADMIN_NAV: readonly NavGroup[] = [
  {
    title: 'Overview',
    links: [{ href: '/admin', label: 'Dashboard', caps: ['analytics.read'] }],
  },
  {
    title: 'Content',
    links: [
      { href: '/admin/services', label: 'Services', caps: ['services.write', 'seo.entityMeta'] },
      { href: '/admin/blog', label: 'Blog', caps: ['blog.write', 'seo.entityMeta'] },
      { href: '/admin/portfolio', label: 'Portfolio', caps: ['portfolio.write', 'seo.entityMeta'] },
      { href: '/admin/pages', label: 'Pages & sections', caps: ['pages.write', 'seo.entityMeta'] },
      { href: '/admin/navigation', label: 'Navigation', caps: ['nav.edit'] },
      { href: '/admin/categories', label: 'Categories', caps: ['categories.manage'] },
      { href: '/admin/team', label: 'Team & authors', caps: ['blog.write'] },
      { href: '/admin/certifications', label: 'Certifications', caps: ['services.write'] },
      { href: '/admin/statistics', label: 'Statistics', caps: ['services.write'] },
      { href: '/admin/partner-logos', label: 'Partner logos', caps: ['services.write'] },
    ],
  },
  {
    title: 'Media',
    links: [
      {
        href: '/admin/media',
        label: 'Media library',
        caps: ['media.write'],
        access: ['full', 'meta'],
      },
    ],
  },
  {
    title: 'SEO',
    links: [
      { href: '/admin/seo', label: 'Global defaults', caps: ['seo.globalDefaults'] },
      { href: '/admin/redirects', label: 'Redirects', caps: ['redirects.manage'] },
      { href: '/admin/analytics/search', label: 'Search analytics', caps: ['analytics.search'] },
    ],
  },
  {
    title: 'Leads',
    links: [{ href: '/admin/leads', label: 'Leads', caps: ['leads.manage'] }],
  },
  {
    title: 'Insights',
    links: [{ href: '/admin/analytics', label: 'Analytics', caps: ['analytics.read'] }],
  },
  {
    title: 'Style-Finder',
    links: [
      { href: '/admin/ai-questions', label: 'Questions', caps: ['ai.editContent'] },
      { href: '/admin/ai-styles', label: 'Styles', caps: ['ai.editContent'] },
      { href: '/admin/ai-config', label: 'Results & logic', caps: ['ai.config'] },
    ],
  },
  {
    title: 'System',
    links: [
      { href: '/admin/settings', label: 'Settings', caps: ['settings.general'] },
      { href: '/admin/integrations', label: 'Integrations', caps: ['settings.integrations'] },
      { href: '/admin/maintenance', label: 'Maintenance', caps: ['maintenance.manage'] },
      { href: '/admin/themes', label: 'Theme', caps: ['theme.edit'] },
      { href: '/admin/users', label: 'Users & roles', caps: ['users.manage'] },
      { href: '/admin/site-health', label: 'Site health', caps: ['siteHealth.view'] },
      { href: '/admin/logs', label: 'System logs', caps: ['logs.view'] },
      { href: '/admin/audit', label: 'Audit log', caps: ['audit.view'] },
    ],
  },
];

const DEFAULT_ACCESS: readonly Access[] = ['full', 'view', 'meta'];

export function isVisible(role: Role, link: NavLink): boolean {
  const allowed = link.access ?? DEFAULT_ACCESS;
  return link.caps.some((cap) => allowed.includes(ROLE_CAPS[role][cap]));
}

/** The menu for a role, with empty groups dropped. */
export function visibleNav(role: Role): NavGroup[] {
  return ADMIN_NAV.map((group) => ({
    title: group.title,
    links: group.links.filter((link) => isVisible(role, link)),
  })).filter((group) => group.links.length > 0);
}
