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
 * Screens only the holders of one capability may use, with the API behind each
 * (tests/admin/refusals.e2e.ts). Every role WITHOUT the capability, which has the screen
 * outside its menu (tests/lib/adminRoutes.spec.ts), must get the server's 403 and see it on
 * the screen: the hidden menu link is not what protects them. How the screen refuses
 * depends on how it is built (`render`, Admin v2 U2; U13's activity log reuses it):
 *   island  the page renders for any member and its island's API answers 403 on mount;
 *           the island shows that refusal (the default);
 *   server  the page reads on the server, so it refuses itself: the response is a 403
 *           and the layout shows the refusal (src/components/admin/ui/Refused.astro),
 *           having read nothing. Its JSON twin, `api`, answers 403 as well.
 */
export interface LockedScreen {
  href: string;
  api: string;
  cap: Capability;
  render?: 'island' | 'server';
}

export const LOCKED_SCREENS: readonly LockedScreen[] = [
  { href: '/admin/users', api: '/api/admin/users', cap: 'users.manage' },
  { href: '/admin/applications', api: '/api/admin/applications', cap: 'applications.manage' },
  { href: '/admin/leads', api: '/api/admin/leads', cap: 'leads.manage' },
  { href: '/admin/audit', api: '/api/admin/audit', cap: 'audit.view', render: 'server' },
  {
    href: '/admin/site-health',
    api: '/api/admin/site-health',
    cap: 'siteHealth.view',
    render: 'server',
  },
  { href: '/admin/settings', api: '/api/admin/settings', cap: 'settings.general' },
  { href: '/admin/integrations', api: '/api/admin/integrations', cap: 'settings.integrations' },
  { href: '/admin/themes', api: '/api/admin/themes', cap: 'theme.edit' },
  { href: '/admin/redirects', api: '/api/admin/redirects', cap: 'redirects.manage' },
  { href: '/admin/service-cases', api: '/api/admin/service-cases', cap: 'services.write' },
  {
    href: '/admin/analytics/search',
    api: '/api/admin/analytics/search',
    cap: 'analytics.search',
    render: 'server',
  },
  { href: '/admin/ai-config', api: '/api/admin/ai-config', cap: 'ai.config' },
  // Admin v2 U14a: Admin + Developer; the island shows the API's 403.
  { href: '/admin/visibility', api: '/api/admin/page-visibility', cap: 'maintenance.manage' },
];

/** How a locked screen refuses (see LockedScreen). */
export function renderOf(screen: LockedScreen): 'island' | 'server' {
  return screen.render ?? 'island';
}

/** The roles a locked screen must refuse: those with no access at all to its capability. */
export function refusedRoles(screen: LockedScreen): Role[] {
  return ROLES.filter((role) => ROLE_CAPS[role][screen.cap] === 'none');
}

/** Reached from inside other screens, never from the sidebar or an area's tabs. */
export const EXTRA_LINKS: readonly NavTab[] = [
  // The header search's results page. The page has no capability gate (each entity is
  // gated inside searchAdmin()), so every role may open it.
  { href: '/admin/search?q=logo', label: 'Search', caps: [] },
  // The personal layer (Admin v2 F8): the no-JS pages behind the account chip and the
  // bell, each the drawer's twin. Every member has an account and a bell.
  { href: '/admin/account', label: 'Your account', caps: [] },
  { href: '/admin/notifications', label: 'Notifications', caps: [] },
  // The component kit (Admin v2 F4b): every kit piece on made-up data, reached by its
  // address. Every member may open it; its content reads nothing (its shell reads what
  // every screen's shell reads).
  { href: '/admin/kit', label: 'Component kit', caps: [] },
  // The help centre (Admin v2 U16): the no-JS twin of the "?" drawer, every member's. Its
  // four views: a screen's guides first, a search, a guide, and a guide's Arabic text (RTL).
  // The guide is one every role may read (supabase/migrations/0046_help_centre.sql).
  { href: '/admin/help?screen=/admin', label: 'Help centre', caps: [] },
  { href: '/admin/help?q=password', label: 'Help search', caps: [] },
  { href: '/admin/help?guide=finding-your-way', label: 'A help guide', caps: [] },
  { href: '/admin/help?guide=finding-your-way&lang=ar', label: 'A help guide in Arabic', caps: [] },
  // The activity log filtered (Admin v2 U13): a kind, a day range and an empty result can
  // render differently from the plain list (the chips' current one, the notes, the empty
  // state), so a filtered view is swept too, for the roles that may read the log.
  {
    href: '/admin/audit?kind=leads&from=2026-01-01',
    label: 'Activity log, filtered',
    caps: ['audit.view'],
  },
  // Website stats and site health (Admin v2 U2): their in-page tabs and range links, each
  // a URL of the same page, with the capability that page or tab asks for.
  {
    href: '/admin/analytics?tab=pages&range=7',
    label: 'Website stats pages',
    caps: ['analytics.read'],
  },
  { href: '/admin/site-health?tab=speed', label: 'Site health speed', caps: ['siteHealth.view'] },
  { href: '/admin/site-health?tab=errors', label: 'Site health errors', caps: ['logs.view'] },
  { href: '/admin/site-health?tab=seo', label: 'Site health SEO', caps: ['siteHealth.view'] },
  // The media library's in-page states (Admin v2 U4): the Videos tab, the "Needs alt text"
  // filter and a search with no match (the empty state), for every role that opens it.
  {
    href: '/admin/media?tab=videos',
    label: 'Media videos',
    caps: ['media.write'],
    access: ['full', 'meta'],
  },
  {
    href: '/admin/media?alt=missing',
    label: 'Media needing alt text',
    caps: ['media.write'],
    access: ['full', 'meta'],
  },
  {
    href: '/admin/media?q=zzzz',
    label: 'Media, no match',
    caps: ['media.write'],
    access: ['full', 'meta'],
  },
];

/**
 * Pages that only redirect (a 302 to another screen), so the sweep, which asks each page for
 * its own 200, does not open them as screens. Each is checked by tests/lib/adminRoutes.spec.ts
 * to redirect where it says, and by its screen's e2e. /admin/media/new: adding a picture is
 * an upload now (U4, D4).
 */
export const REDIRECT_PAGES: Readonly<Record<string, string>> = {
  '/admin/media/new': '/admin/media?upload=1',
};

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
  // A filtered view of a screen (an extra such as /admin/media?tab=videos) derives the same
  // create and edit screens as the screen itself: each is swept once.
  const derived = new Set<string>();
  for (const link of links) {
    if (link.caps.length > 0 && !isVisible(role, link)) continue;
    pageFileFor(link.href, exists);
    const base = link.href.split('?')[0] ?? link.href;
    routes.push({ path: link.href, pattern: base, kind: 'screen' });

    const author = link.caps[0];
    const create = `${base}/new`;
    if (
      author &&
      ROLE_CAPS[role][author] === 'full' &&
      hasPage(create, exists) &&
      !(create in REDIRECT_PAGES) &&
      !derived.has(create)
    ) {
      derived.add(create);
      routes.push({ path: create, pattern: create, kind: 'create' });
    }
    if (hasPage(`${base}/[id]`, exists) && !derived.has(`${base}/[id]`)) {
      derived.add(`${base}/[id]`);
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

/**
 * What names a swept route in a test title: the URL visited, except an edit screen, whose
 * URL holds `[id]` until run time (its pattern then). Never the pattern alone: the help
 * page's four views share one pattern, and Playwright refuses a repeated title when it
 * collects the suites, which aborts the whole e2e job before any test runs.
 */
export function routeKey(route: SweepRoute): string {
  return route.kind === 'edit' ? route.pattern : route.path;
}

/** The design capture's viewports (tests/admin/capture.e2e.ts): a laptop and a phone. */
export const CAPTURE_VIEWPORTS = [
  { tag: 'd', width: 1440, height: 900 },
  { tag: 'm', width: 390, height: 844 },
] as const;

/** What the capture takes for a role: Admin every screen, the others their dashboard. */
export function captureRoutes(role: Role, exists: Exists = existsSync): SweepRoute[] {
  const routes = sweepRoutes(role, exists);
  return role === 'admin' ? routes : routes.slice(0, 1);
}

/** A route key as a file name: every run of `/ ? = & [ ]` is one underscore. */
export function captureSlug(key: string): string {
  return key.replace(/[/?=&[\]]+/g, '_').replace(/^_|_$/g, '') || 'admin';
}

/** A capture's test title, and its picture's file name. */
export function captureName(role: Role, viewport: string, route: SweepRoute): string {
  return `admin-${role}-${viewport}-${captureSlug(routeKey(route))}`;
}

/** The sidebar the role should see, as the server renders it: group titles and links. */
export function expectedSidebar(role: Role): { title: string; links: string[] }[] {
  return visibleNav(role).map((group) => ({
    title: group.title,
    links: group.links.map((link) => `${link.label} ${link.href}`),
  }));
}
