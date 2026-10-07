import type { Role } from '@/lib/auth/types';
import { ROLE_CAPS, type Access, type Capability } from '@/lib/authz/matrix';
import type { IconName } from './icons';

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
//
// ── Admin v2 (F2): the prototype's information architecture ─────────────────────────
// Groups and labels follow the client's prototype (docs/admin-v2/ui.md §3.1): Overview,
// Content, CRM, Hiring, Growth, Appearance, Settings. A screen the prototype folds into
// another area (Disciplines into Services, Sectors into Projects, System logs into Site
// health…) is a TAB of that area's link: it is reached from the area's page head, and its
// URL lights the area's sidebar link up (`match`). The retired routes stay real pages
// until the slice that builds their replacement turns them into redirects.

export interface NavTab {
  href: string;
  label: string;
  /** Visible when the role holds ANY of these at `access`. */
  caps: readonly Capability[];
  access?: readonly Access[];
}

export interface NavLink extends NavTab {
  icon: IconName;
  /** Other routes that belong to this area and light its link up. */
  match?: readonly string[];
  /** A head count the shell computes for roles that see the link (src/lib/admin/shell.ts). */
  count?: NavCount;
  /** The area's screens, shown as tabs in its page head when the role sees two or more. */
  tabs?: readonly NavTab[];
}

export type NavCount = 'leads' | 'applications';

export interface NavGroup {
  title: string;
  links: readonly NavLink[];
}

export const ADMIN_NAV: readonly NavGroup[] = [
  {
    title: 'Overview',
    links: [{ href: '/admin', label: 'Dashboard', icon: 'home', caps: ['analytics.read'] }],
  },
  {
    title: 'Content',
    links: [
      {
        href: '/admin/pages',
        label: 'Pages',
        icon: 'pages',
        caps: ['pages.write', 'seo.entityMeta'],
        match: ['/admin/sections'],
        tabs: [
          { href: '/admin/pages', label: 'Pages', caps: ['pages.write', 'seo.entityMeta'] },
          { href: '/admin/sections', label: 'Sections', caps: ['pages.write'] },
        ],
      },
      {
        href: '/admin/services',
        label: 'Services',
        icon: 'layers',
        caps: ['services.write', 'seo.entityMeta'],
        match: ['/admin/disciplines', '/admin/service-cases'],
        tabs: [
          {
            href: '/admin/services',
            label: 'Services',
            caps: ['services.write', 'seo.entityMeta'],
          },
          { href: '/admin/disciplines', label: 'Disciplines', caps: ['services.write'] },
          { href: '/admin/service-cases', label: 'Case studies', caps: ['services.write'] },
        ],
      },
      {
        href: '/admin/portfolio',
        label: 'Projects',
        icon: 'briefcase',
        caps: ['portfolio.write', 'seo.entityMeta'],
        match: ['/admin/sectors'],
        tabs: [
          {
            href: '/admin/portfolio',
            label: 'Projects',
            caps: ['portfolio.write', 'seo.entityMeta'],
          },
          { href: '/admin/sectors', label: 'Sectors', caps: ['categories.manage'] },
        ],
      },
      {
        href: '/admin/blog',
        label: 'Creative Knowledge',
        icon: 'type',
        caps: ['blog.write', 'seo.entityMeta'],
        match: ['/admin/categories'],
        tabs: [
          { href: '/admin/blog', label: 'Posts', caps: ['blog.write', 'seo.entityMeta'] },
          { href: '/admin/categories', label: 'Categories', caps: ['categories.manage'] },
        ],
      },
      {
        href: '/admin/testimonials',
        label: 'Testimonials',
        icon: 'quote',
        caps: ['portfolio.write'],
      },
      { href: '/admin/clients', label: 'Clients', icon: 'star', caps: ['portfolio.write'] },
      { href: '/admin/team', label: 'Team', icon: 'users', caps: ['blog.write'] },
      { href: '/admin/statistics', label: 'Numbers', icon: 'grid', caps: ['services.write'] },
      {
        href: '/admin/certifications',
        label: 'Certifications',
        icon: 'tag',
        caps: ['services.write'],
      },
      {
        href: '/admin/media',
        label: 'Media library',
        icon: 'image',
        caps: ['media.write'],
        access: ['full', 'meta'],
      },
    ],
  },
  {
    title: 'CRM',
    links: [
      {
        href: '/admin/leads',
        label: 'Leads',
        icon: 'inbox',
        caps: ['leads.manage'],
        count: 'leads',
      },
    ],
  },
  {
    title: 'Hiring',
    links: [
      // Join (careers): Admin only — owner decision J6. Never part of the CRM.
      {
        href: '/admin/applications',
        label: 'Job applications',
        icon: 'hand',
        caps: ['applications.manage'],
        count: 'applications',
      },
    ],
  },
  {
    title: 'Growth',
    links: [
      {
        href: '/admin/analytics',
        label: 'Website stats',
        icon: 'chart',
        caps: ['analytics.read'],
        match: ['/admin/analytics/search'],
        tabs: [
          { href: '/admin/analytics', label: 'Overview', caps: ['analytics.read'] },
          { href: '/admin/analytics/search', label: 'Search', caps: ['analytics.search'] },
        ],
      },
      {
        href: '/admin/site-health',
        label: 'Site health',
        icon: 'shield',
        caps: ['siteHealth.view'],
        match: ['/admin/logs'],
        tabs: [
          { href: '/admin/site-health', label: 'Health', caps: ['siteHealth.view'] },
          { href: '/admin/logs', label: 'Errors', caps: ['logs.view'] },
        ],
      },
      {
        href: '/admin/ai-questions',
        label: 'Style-Finder',
        icon: 'sparkle',
        caps: ['ai.editContent'],
        match: ['/admin/ai-styles', '/admin/ai-config'],
        tabs: [
          { href: '/admin/ai-questions', label: 'Questions', caps: ['ai.editContent'] },
          { href: '/admin/ai-styles', label: 'Styles', caps: ['ai.editContent'] },
          { href: '/admin/ai-config', label: 'Results & logic', caps: ['ai.config'] },
        ],
      },
    ],
  },
  {
    title: 'Appearance',
    links: [
      { href: '/admin/themes', label: 'Theme', icon: 'palette', caps: ['theme.edit'] },
      { href: '/admin/navigation', label: 'Menus', icon: 'header', caps: ['nav.edit'] },
    ],
  },
  {
    title: 'Settings',
    links: [
      {
        href: '/admin/settings',
        label: 'General',
        icon: 'settings',
        caps: ['settings.general'],
        match: ['/admin/maintenance'],
        tabs: [
          { href: '/admin/settings', label: 'General', caps: ['settings.general'] },
          { href: '/admin/maintenance', label: 'Maintenance', caps: ['maintenance.manage'] },
        ],
      },
      {
        href: '/admin/seo',
        label: 'SEO',
        icon: 'seo',
        caps: ['seo.globalDefaults', 'redirects.manage'],
        match: ['/admin/redirects'],
        tabs: [
          { href: '/admin/seo', label: 'Defaults', caps: ['seo.globalDefaults'] },
          { href: '/admin/redirects', label: 'Redirects', caps: ['redirects.manage'] },
        ],
      },
      {
        href: '/admin/integrations',
        label: 'Integrations',
        icon: 'plug',
        caps: ['settings.integrations'],
      },
      { href: '/admin/users', label: 'Users & roles', icon: 'key', caps: ['users.manage'] },
      { href: '/admin/audit', label: 'Activity log', icon: 'history', caps: ['audit.view'] },
    ],
  },
];

const DEFAULT_ACCESS: readonly Access[] = ['full', 'view', 'meta'];

export function isVisible(role: Role, link: NavTab): boolean {
  const allowed = link.access ?? DEFAULT_ACCESS;
  return link.caps.some((cap) => allowed.includes(ROLE_CAPS[role][cap]));
}

/** The menu for a role: links it may see, each with only the tabs it may see. */
export function visibleNav(role: Role): NavGroup[] {
  return ADMIN_NAV.map((group) => ({
    title: group.title,
    links: group.links
      .filter((link) => isVisible(role, link))
      .map((link) =>
        link.tabs ? { ...link, tabs: link.tabs.filter((tab) => isVisible(role, tab)) } : link,
      ),
  })).filter((group) => group.links.length > 0);
}

/** Every screen a role reaches from the menu: sidebar links and their tabs, deduplicated. */
export function reachableHrefs(role: Role): string[] {
  const hrefs = visibleNav(role).flatMap((group) =>
    group.links.flatMap((link) => [link.href, ...(link.tabs ?? []).map((tab) => tab.href)]),
  );
  return [...new Set(hrefs)];
}

/** True when `path` is `href` itself or a page below it (never a sibling sharing a prefix). */
function under(path: string, href: string): boolean {
  return path === href || path.startsWith(`${href}/`);
}

/**
 * The sidebar link whose area holds `path`: the link's own route or one of its `match`
 * routes, the longest match winning. The dashboard matches only itself.
 */
export function currentLink(nav: readonly NavGroup[], path: string): NavLink | null {
  let best: { link: NavLink; length: number } | null = null;
  for (const link of nav.flatMap((group) => group.links)) {
    const routes = link.href === '/admin' ? [] : [link.href, ...(link.match ?? [])];
    if (link.href === '/admin' && path === '/admin') return link;
    for (const route of routes) {
      if (under(path, route) && (!best || route.length > best.length)) {
        best = { link, length: route.length };
      }
    }
  }
  return best?.link ?? null;
}

/** The tab of `link` that holds `path` (the longest match), when the area has tabs. */
export function currentTab(link: NavLink, path: string): NavTab | null {
  let best: NavTab | null = null;
  for (const tab of link.tabs ?? []) {
    if (under(path, tab.href) && (!best || tab.href.length > best.href.length)) best = tab;
  }
  return best;
}
