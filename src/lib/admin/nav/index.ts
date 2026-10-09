import type { Role } from '@/lib/auth/types';
import { ROLE_CAPS, type Access } from '@/lib/authz/matrix';
import { appearance } from './appearance';
import { content } from './content';
import { crm } from './crm';
import { growth } from './growth';
import { hiring } from './hiring';
import { overview } from './overview';
import { settings } from './settings';
import type { NavArea, NavGroup, NavLink, NavTab } from './types';

export type { NavArea, NavCount, NavGroup, NavLink, NavTab } from './types';

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
//
// ── Admin v2 (W0): one module per area ─────────────────────────────────────────────
// Each group is its own module (nav/<area>.ts): its title, its place in the menu
// (`order`) and its links. This file composes them and holds the rules that read them. A
// slice that adds a screen edits its area's module; a new area is a module and one line
// in NAV_AREAS.

/** Every area of the menu, in any order: ADMIN_NAV sorts them by `order`. */
export const NAV_AREAS: readonly NavArea[] = [
  appearance,
  content,
  crm,
  growth,
  hiring,
  overview,
  settings,
];

export const ADMIN_NAV: readonly NavGroup[] = [...NAV_AREAS]
  .sort((a, b) => a.order - b.order)
  .map(({ title, links }) => ({ title, links }));

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
