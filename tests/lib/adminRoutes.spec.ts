import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROLES, type Role } from '@/lib/auth/types';
import { ROLE_CAPS, type Capability } from '@/lib/authz/matrix';
import { reachableHrefs } from '@/lib/admin/nav';
import * as resources from '@/lib/admin/resources';
import type { ResourceConfig } from '@/lib/admin/resource';
import {
  EXTRA_LINKS,
  UNSEEDED_LISTS,
  expectedSidebar,
  menuScreens,
  pageFileFor,
  sweepRoutes,
} from '../admin/routes';

// The admin sweep's route map (tests/admin/routes.ts) against the server. The sweep only
// visits what a role should be able to use; these checks make "should" mean what the
// server enforces, so a sweep that passes cannot be passing on screens the API refuses.

/** Admin URL segment → the resource config its API routes are built from. */
const RESOURCE_BY_SEGMENT: Record<string, { config: ResourceConfig; exportName: string }> = {
  'ai-questions': { config: resources.aiQuestionResource, exportName: 'aiQuestionResource' },
  'ai-styles': { config: resources.aiStyleResource, exportName: 'aiStyleResource' },
  blog: { config: resources.postResource, exportName: 'postResource' },
  categories: { config: resources.categoryResource, exportName: 'categoryResource' },
  certifications: { config: resources.certificationResource, exportName: 'certificationResource' },
  clients: { config: resources.clientResource, exportName: 'clientResource' },
  disciplines: { config: resources.disciplineResource, exportName: 'disciplineResource' },
  media: { config: resources.mediaResource, exportName: 'mediaResource' },
  navigation: { config: resources.navigationResource, exportName: 'navigationResource' },
  pages: { config: resources.pageResource, exportName: 'pageResource' },
  portfolio: { config: resources.portfolioResource, exportName: 'portfolioResource' },
  redirects: { config: resources.redirectResource, exportName: 'redirectResource' },
  sections: { config: resources.sectionResource, exportName: 'sectionResource' },
  sectors: { config: resources.sectorResource, exportName: 'sectorResource' },
  'service-cases': { config: resources.serviceCaseResource, exportName: 'serviceCaseResource' },
  services: { config: resources.serviceResource, exportName: 'serviceResource' },
  statistics: { config: resources.statisticResource, exportName: 'statisticResource' },
  team: { config: resources.teamResource, exportName: 'teamResource' },
  testimonials: { config: resources.testimonialResource, exportName: 'testimonialResource' },
  themes: { config: resources.themeResource, exportName: 'themeResource' },
};

const segmentOf = (pattern: string) => pattern.split('/')[2] ?? '';
const holds = (role: Role, cap: Capability, access: readonly string[]) =>
  access.includes(ROLE_CAPS[role][cap]);

describe('the sweep route map', () => {
  it('every route resolves to a page file', () => {
    for (const role of ROLES) {
      for (const route of sweepRoutes(role)) {
        expect(() => pageFileFor(route.path), route.path).not.toThrow();
      }
    }
  });

  it('every create and edit screen belongs to a known resource whose API uses that config', () => {
    for (const route of sweepRoutes('admin').filter((r) => r.kind !== 'screen')) {
      const segment = segmentOf(route.pattern);
      const entry = RESOURCE_BY_SEGMENT[segment];
      expect(entry, `no resource mapped for ${route.pattern}`).toBeDefined();
      const api = readFileSync(`src/pages/api/admin/${segment}/index.ts`, 'utf8');
      expect(api, `src/pages/api/admin/${segment}/index.ts`).toContain(entry!.exportName);
      // An edit screen opens the first row of the list that file serves.
      if (route.kind === 'edit') expect(route.listApi).toBe(`/api/admin/${segment}`);
    }
  });

  it('a role is sent to a create screen only if it holds the write capability in full', () => {
    for (const role of ROLES) {
      for (const route of sweepRoutes(role).filter((r) => r.kind === 'create')) {
        const { config } = RESOURCE_BY_SEGMENT[segmentOf(route.pattern)]!;
        expect(holds(role, config.writeCap, ['full']), `${role} ${route.path}`).toBe(true);
      }
    }
  });

  it('a role is sent to an edit screen only if its list API admits it', () => {
    // The sweep fails on a refused list, so this must hold exactly as the kernel reads
    // it: any read capability, at the resource's own read access.
    for (const role of ROLES) {
      for (const route of sweepRoutes(role).filter((r) => r.kind === 'edit')) {
        const { config } = RESOURCE_BY_SEGMENT[segmentOf(route.pattern)]!;
        const readCaps = config.readCaps ?? [config.writeCap];
        const access = config.readAccess ?? ['full', 'view', 'meta'];
        expect(
          readCaps.some((cap) => holds(role, cap, access)),
          `${role} ${route.path}`,
        ).toBe(true);
      }
    }
  });

  it('skips an edit screen only where the seed leaves its table empty', () => {
    const seed = readFileSync('supabase/seed.sql', 'utf8');
    const seeds = (table: string) =>
      new RegExp(String.raw`insert into (?:public\.)?${table}\b`, 'i').test(seed);
    const edits = sweepRoutes('admin').filter((r) => r.kind === 'edit');
    for (const [listApi, table] of Object.entries(UNSEEDED_LISTS)) {
      expect(seeds(table), `seed.sql inserts ${table} rows: drop it from UNSEEDED_LISTS`).toBe(
        false,
      );
      expect(
        edits.map((r) => r.listApi),
        listApi,
      ).toContain(listApi);
    }
    // And every other edit screen's table has seed rows, so an empty list there is a defect.
    for (const route of edits.filter((r) => !((r.listApi ?? '') in UNSEEDED_LISTS))) {
      const { table } = RESOURCE_BY_SEGMENT[segmentOf(route.pattern)]!.config;
      expect(seeds(table), `${route.pattern}: seed.sql inserts no ${table} row`).toBe(true);
    }
  });

  it('a role that may author a resource it sees is sent to its create screen', () => {
    for (const role of ROLES) {
      const routes = new Set(sweepRoutes(role).map((r) => r.path));
      for (const route of sweepRoutes(role).filter((r) => r.kind === 'edit')) {
        const segment = segmentOf(route.pattern);
        const { config } = RESOURCE_BY_SEGMENT[segment]!;
        let hasNew = true;
        try {
          pageFileFor(`/admin/${segment}/new`);
        } catch {
          hasNew = false;
        }
        if (hasNew && holds(role, config.writeCap, ['full'])) {
          expect(routes, `${role} /admin/${segment}/new`).toContain(`/admin/${segment}/new`);
        }
      }
    }
  });

  it('Admin is swept on every sidebar link and tab, and the extras', () => {
    const paths = new Set(sweepRoutes('admin').map((r) => r.path));
    for (const screen of [...menuScreens(), ...EXTRA_LINKS]) {
      expect(paths, screen.href).toContain(screen.href);
    }
  });

  it('each role is swept on exactly the screens its menu reaches, plus the extras', () => {
    for (const role of ROLES) {
      const screens = sweepRoutes(role)
        .filter((r) => r.kind === 'screen')
        .map((r) => r.path)
        .filter((p) => !EXTRA_LINKS.some((l) => l.href === p));
      expect(new Set(screens)).toEqual(new Set(reachableHrefs(role)));
    }
  });
});

// Each role's sidebar, written out from the CLAUDE.md §5 matrix rather than computed: the
// sweep holds the sidebar the server renders to expectedSidebar(), so expectedSidebar()
// needs an oracle that is not nav.ts itself. A capability or menu change that alters what
// a role sees has to be made here too, on purpose.
const SIDEBAR: Record<Role, Record<string, string[]>> = {
  admin: {
    Overview: ['Dashboard /admin'],
    Content: [
      'Pages /admin/pages',
      'Services /admin/services',
      'Projects /admin/portfolio',
      'Creative Knowledge /admin/blog',
      'Testimonials /admin/testimonials',
      'Clients /admin/clients',
      'Team /admin/team',
      'Numbers /admin/statistics',
      'Certifications /admin/certifications',
      'Media library /admin/media',
    ],
    CRM: ['Leads /admin/leads'],
    Hiring: ['Job applications /admin/applications'],
    Growth: [
      'Website stats /admin/analytics',
      'Site health /admin/site-health',
      'Style-Finder /admin/ai-questions',
    ],
    Appearance: ['Theme /admin/themes', 'Menus /admin/navigation'],
    Settings: [
      'General /admin/settings',
      'SEO /admin/seo',
      'Integrations /admin/integrations',
      'Users & roles /admin/users',
      'Activity log /admin/audit',
    ],
  },
  // Authors and publishes; no leads, applications, settings, logs or theme.
  content_creator: {
    Overview: ['Dashboard /admin'],
    Content: [
      'Pages /admin/pages',
      'Services /admin/services',
      'Projects /admin/portfolio',
      'Creative Knowledge /admin/blog',
      'Testimonials /admin/testimonials',
      'Clients /admin/clients',
      'Team /admin/team',
      'Numbers /admin/statistics',
      'Certifications /admin/certifications',
      'Media library /admin/media',
    ],
    Growth: ['Website stats /admin/analytics', 'Style-Finder /admin/ai-questions'],
    Appearance: ['Menus /admin/navigation'],
  },
  // Entity meta (so the content lists, not their bodies), media meta, SEO, integrations.
  seo: {
    Overview: ['Dashboard /admin'],
    Content: [
      'Pages /admin/pages',
      'Services /admin/services',
      'Projects /admin/portfolio',
      'Creative Knowledge /admin/blog',
      'Media library /admin/media',
    ],
    Growth: ['Website stats /admin/analytics'],
    Settings: ['SEO /admin/seo', 'Integrations /admin/integrations'],
  },
  // Technical: media, leads, health, theme, settings, audit; no content, no applications.
  developer: {
    Overview: ['Dashboard /admin'],
    Content: ['Media library /admin/media'],
    CRM: ['Leads /admin/leads'],
    Growth: ['Website stats /admin/analytics', 'Site health /admin/site-health'],
    Appearance: ['Theme /admin/themes'],
    Settings: ['General /admin/settings', 'Activity log /admin/audit'],
  },
};

describe("the sweep's expected sidebar", () => {
  it.each(ROLES)('%s: the menu §5 gives the role, label and href', (role) => {
    expect(expectedSidebar(role)).toEqual(
      Object.entries(SIDEBAR[role]).map(([title, links]) => ({ title, links })),
    );
  });
});
