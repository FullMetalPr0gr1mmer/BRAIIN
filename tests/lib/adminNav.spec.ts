import { describe, expect, it } from 'vitest';
import { ROLES } from '@/lib/auth/types';
import {
  ADMIN_NAV,
  NAV_AREAS,
  currentLink,
  currentTab,
  reachableHrefs,
  visibleNav,
  type NavLink,
} from '@/lib/admin/nav';
import { ICON_NAMES } from '@/lib/admin/icons';
import { pageFileFor } from '../admin/routes';

// The Admin v2 information architecture (F2, docs/admin-v2/ui.md §3.1): the prototype's
// groups, an icon per link, and the screens it folds into an area as that area's tabs.

const links = ADMIN_NAV.flatMap((group) => group.links);
const byHref = (href: string) => links.find((link) => link.href === href) as NavLink;

describe('the admin menu', () => {
  it("follows the prototype's groups, in order", () => {
    expect(visibleNav('admin').map((group) => group.title)).toEqual([
      'Overview',
      'Content',
      'CRM',
      'Hiring',
      'Growth',
      'Appearance',
      'Settings',
    ]);
  });

  it('gives every link an icon from the sprite', () => {
    for (const link of links) expect(ICON_NAMES, link.href).toContain(link.icon);
  });

  it('points every link, tab and match route at a page that exists', () => {
    for (const link of links) {
      for (const href of [
        link.href,
        ...(link.tabs ?? []).map((t) => t.href),
        ...(link.match ?? []),
      ]) {
        expect(() => pageFileFor(href), href).not.toThrow();
      }
    }
  });

  it("lists an area's own screen first among its tabs", () => {
    for (const link of links.filter((l) => l.tabs)) expect(link.tabs?.[0]?.href).toBe(link.href);
  });

  it('keeps every screen of the old menu reachable for the roles that had it', () => {
    // Folding Disciplines, Sectors, System logs… into tabs must not strand a role.
    expect(reachableHrefs('content_creator')).toEqual(
      expect.arrayContaining(['/admin/disciplines', '/admin/service-cases', '/admin/sectors']),
    );
    expect(reachableHrefs('developer')).toEqual(
      expect.arrayContaining(['/admin/logs', '/admin/maintenance', '/admin/analytics/search']),
    );
    expect(reachableHrefs('seo')).toEqual(
      expect.arrayContaining(['/admin/redirects', '/admin/analytics/search']),
    );
  });

  it('shows no tab row where the role can open only one screen of the area', () => {
    const services = visibleNav('seo')
      .flatMap((g) => g.links)
      .find((l) => l.href === '/admin/services');
    expect(services?.tabs?.map((t) => t.href)).toEqual(['/admin/services']);
  });

  it('every role has a reachable dashboard or a first screen', () => {
    for (const role of ROLES) expect(reachableHrefs(role).length).toBeGreaterThan(0);
  });
});

describe('the area modules (nav/<area>.ts)', () => {
  it("compose the menu: the prototype's seven groups, each with its own place", () => {
    // Pinned here, not derived: an area module dropped from NAV_AREAS must fail.
    expect(ADMIN_NAV.map((group) => group.title)).toEqual([
      'Overview',
      'Content',
      'CRM',
      'Hiring',
      'Growth',
      'Appearance',
      'Settings',
    ]);
    expect(new Set(NAV_AREAS.map((area) => area.order)).size).toBe(NAV_AREAS.length);
    expect(new Set(NAV_AREAS.map((area) => area.title)).size).toBe(NAV_AREAS.length);
  });

  it('hand the menu a group of title and links only, never the sort key', () => {
    for (const group of ADMIN_NAV) expect(Object.keys(group).sort()).toEqual(['links', 'title']);
  });
});

describe('currentLink', () => {
  const nav = visibleNav('admin');

  it('matches the dashboard only on itself', () => {
    expect(currentLink(nav, '/admin')?.href).toBe('/admin');
    expect(currentLink(nav, '/admin/nowhere')).toBeNull();
  });

  it("lights an area's link for its own pages and its folded screens", () => {
    expect(currentLink(nav, '/admin/services/0a1b')?.href).toBe('/admin/services');
    expect(currentLink(nav, '/admin/disciplines')?.href).toBe('/admin/services');
    expect(currentLink(nav, '/admin/service-cases/new')?.href).toBe('/admin/services');
    expect(currentLink(nav, '/admin/sections/9')?.href).toBe('/admin/pages');
    expect(currentLink(nav, '/admin/logs')?.href).toBe('/admin/site-health');
    expect(currentLink(nav, '/admin/redirects/new')?.href).toBe('/admin/seo');
  });

  it('never matches a sibling that only shares a prefix', () => {
    expect(currentLink(nav, '/admin/services-archive')).toBeNull();
  });
});

describe('currentTab', () => {
  it('picks the longest matching tab', () => {
    const stats = byHref('/admin/analytics');
    expect(currentTab(stats, '/admin/analytics')?.label).toBe('Overview');
    expect(currentTab(stats, '/admin/analytics/search')?.label).toBe('Search');
  });

  it("marks the area's own tab on its edit pages", () => {
    expect(currentTab(byHref('/admin/services'), '/admin/services/0a1b')?.label).toBe('Services');
    expect(currentTab(byHref('/admin/services'), '/admin/disciplines/new')?.label).toBe(
      'Disciplines',
    );
  });
});
