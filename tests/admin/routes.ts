import { existsSync } from 'node:fs';
import { ADMIN_NAV, isVisible, visibleNav, type NavTab } from '@/lib/admin/nav';
import { ROLE_CAPS } from '@/lib/authz/matrix';
import type { Role } from '@/lib/auth/types';

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
