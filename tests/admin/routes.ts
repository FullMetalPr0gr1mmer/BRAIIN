import { existsSync } from 'node:fs';
import { ADMIN_NAV, isVisible, visibleNav, type NavTab } from '@/lib/admin/nav';
import { ROLE_CAPS, type Capability } from '@/lib/authz/matrix';
import { ROLES, type Role } from '@/lib/auth/types';

/*
 * Which admin screens the per-role sweep visits (Admin v2 F0).
 *
 * Derived from ADMIN_NAV, the sidebar the server renders from ROLE_CAPS, so a capability
 * moved in CLAUDE.md §5 moves the sweep with it. Per role:
 *   - every sidebar link and every tab of its area (the list or singleton screens);
 *   - its create screen (`new.astro`) when the role holds the link's FIRST capability in
 *     full: the authoring one (`services.write` on Services, not SEO's `seo.entityMeta`);
 *   - one edit screen (`[id].astro`) for every list the role sees, opened on the first
 *     row the role's own list API returns.
 * Screens reached only from inside other screens are in EXTRA_LINKS, in the same shape.
 * tests/lib/adminRoutes.spec.ts checks the map against the server's resource config: a
 * swept create screen needs the resource's write capability, an edit screen a read one.
 */

export interface SweepRoute {
  /** The URL visited. For an edit screen `[id]` is replaced by a row id at run time. */
  path: string;
  /** The page's route pattern ("/admin/services/[id]"): the key for baselines. */
  pattern: string;
  kind: 'screen' | 'create' | 'edit';
  /** Edit screens: the list API whose first row supplies the id. */
  listApi?: string;
}

/**
 * The edit screens' lists the seed leaves EMPTY (supabase/seed.sql inserts no row into these
 * tables, list API → table), so those screens have no row to open. Any other list that
 * answers no row fails the sweep: a filter or RLS change that hides rows looks exactly
 * like that. tests/lib/adminRoutes.spec.ts holds this map to the seed.
 */
export const UNSEEDED_LISTS: Readonly<Record<string, string>> = {
  '/api/admin/redirects': 'redirects',
  '/api/admin/themes': 'custom_themes',
  '/api/admin/ai-questions': 'ai_questions',
  '/api/admin/ai-styles': 'ai_styles',
};

/**
 * Screens only the holders of one capability may use, with the API each one's island loads
 * on mount (tests/admin/refusals.e2e.ts). Every role WITHOUT the capability, which has the
 * screen outside its menu (tests/lib/adminRoutes.spec.ts), must get the server's 403 from
 * the API and see it on the screen: the hidden menu link is not what protects them.
 */
export interface LockedScreen {
  href: string;
  api: string;
  cap: Capability;
}

export const LOCKED_SCREENS: readonly LockedScreen[] = [
  { href: '/admin/users', api: '/api/admin/users', cap: 'users.manage' },
  { href: '/admin/applications', api: '/api/admin/applications', cap: 'applications.manage' },
  { href: '/admin/leads', api: '/api/admin/leads', cap: 'leads.manage' },
  { href: '/admin/audit', api: '/api/admin/audit', cap: 'audit.view' },
  { href: '/admin/logs', api: '/api/admin/logs', cap: 'logs.view' },
  { href: '/admin/site-health', api: '/api/admin/site-health', cap: 'siteHealth.view' },
  { href: '/admin/settings', api: '/api/admin/settings', cap: 'settings.general' },
  { href: '/admin/integrations', api: '/api/admin/integrations', cap: 'settings.integrations' },
  { href: '/admin/themes', api: '/api/admin/themes', cap: 'theme.edit' },
  { href: '/admin/redirects', api: '/api/admin/redirects', cap: 'redirects.manage' },
  { href: '/admin/service-cases', api: '/api/admin/service-cases', cap: 'services.write' },
  { href: '/admin/analytics/search', api: '/api/admin/analytics/search', cap: 'analytics.search' },
  { href: '/admin/ai-config', api: '/api/admin/ai-config', cap: 'ai.config' },
];

/** The roles a locked screen must refuse: those with no access at all to its capability. */
export function refusedRoles(screen: LockedScreen): Role[] {
  return ROLES.filter((role) => ROLE_CAPS[role][screen.cap] === 'none');
}

/** Reached from inside other screens, never from the sidebar or an area's tabs. */
export const EXTRA_LINKS: readonly NavTab[] = [
  // The header search's results page. The page has no capability gate (each entity is
  // gated inside searchAdmin()), so every role may open it.
  { href: '/admin/search?q=logo', label: 'Search', caps: [] },
];

/** Every screen of the menu: sidebar links, then their tabs, each once. */
export function menuScreens(): NavTab[] {
  const seen = new Set<string>();
  const screens: NavTab[] = [];
  for (const link of ADMIN_NAV.flatMap((group) => group.links)) {
    for (const screen of [link, ...(link.tabs ?? [])]) {
      if (seen.has(screen.href)) continue;
      seen.add(screen.href);
      screens.push(screen);
    }
  }
  return screens;
}

type Exists = (path: string) => boolean;

const PAGES_DIR = 'src/pages';

function hasPage(route: string, exists: Exists): boolean {
  return exists(`${PAGES_DIR}${route}.astro`);
}

/** The page file behind an href: `<path>.astro` or `<path>/index.astro`. */
export function pageFileFor(href: string, exists: Exists = existsSync): string {
  const path = href.split('?')[0] ?? href;
  if (hasPage(path, exists)) return `${PAGES_DIR}${path}.astro`;
  if (hasPage(`${path}/index`, exists)) return `${PAGES_DIR}${path}/index.astro`;
  throw new Error(`no page for ${href}`);
}

export function sweepRoutes(role: Role, exists: Exists = existsSync): SweepRoute[] {
  const links = [...menuScreens(), ...EXTRA_LINKS];
  const routes: SweepRoute[] = [];
  for (const link of links) {
    if (link.caps.length > 0 && !isVisible(role, link)) continue;
    pageFileFor(link.href, exists);
    const base = link.href.split('?')[0] ?? link.href;
    routes.push({ path: link.href, pattern: base, kind: 'screen' });

    const author = link.caps[0];
    if (author && ROLE_CAPS[role][author] === 'full' && hasPage(`${base}/new`, exists)) {
      routes.push({ path: `${base}/new`, pattern: `${base}/new`, kind: 'create' });
    }
    if (hasPage(`${base}/[id]`, exists)) {
      routes.push({
        path: `${base}/[id]`,
        pattern: `${base}/[id]`,
        kind: 'edit',
        listApi: `/api${base}`,
      });
    }
  }
  return routes;
}

/** The sidebar the role should see, as the server renders it: group titles and links. */
export function expectedSidebar(role: Role): { title: string; links: string[] }[] {
  return visibleNav(role).map((group) => ({
    title: group.title,
    links: group.links.map((link) => `${link.label} ${link.href}`),
  }));
}
