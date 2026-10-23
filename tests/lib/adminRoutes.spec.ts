import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROLES, type Role } from '@/lib/auth/types';
import { ROLE_CAPS, type Capability } from '@/lib/authz/matrix';
import { reachableHrefs } from '@/lib/admin/nav';
import { FORM_IDS, formsTabHref } from '@/lib/admin/forms/overview';
import * as resources from '@/lib/admin/resources';
import type { ResourceConfig } from '@/lib/admin/resource';
import {
  CAPTURE_VIEWPORTS,
  EDIT_SAMPLES,
  EXTRA_LINKS,
  LOCKED_APIS,
  LOCKED_SCREENS,
  REDIRECT_PAGES,
  UNSEEDED_LISTS,
  editRowRequest,
  captureName,
  captureRoutes,
  captureSlug,
  expectedSidebar,
  menuScreens,
  pageFileFor,
  refusedRoles,
  renderOf,
  routeKey,
  sweepRoutes,
} from '../admin/routes';

// The admin sweep's route map (tests/admin/routes.ts) against the server. The sweep only
// visits what a role should be able to use; these checks make "should" mean what the
// server enforces, so a sweep that passes cannot be passing on screens the API refuses.

/** The name the API routes import a registered config by (`export const xResource`). */
function exportNameOf(config: ResourceConfig): string {
  const name = Object.entries(resources).find(
    ([key, value]) => key !== 'RESOURCES' && value === config,
  )?.[0];
  if (!name) throw new Error(`${config.table}: registered, but not exported by name`);
  return name;
}

/** Admin URL segment → the resource config its API routes are built from (the registry). */
const RESOURCE_BY_SEGMENT: Record<string, { config: ResourceConfig; exportName: string }> =
  Object.fromEntries(
    Object.entries(resources.RESOURCES).map(([segment, config]) => [
      segment,
      { config, exportName: exportNameOf(config) },
    ]),
  );

/** Pinned, not derived: a segment dropped from the registry must fail, not go unchecked. */
const SEGMENTS = [
  'ai-questions',
  'ai-styles',
  'blog',
  'categories',
  'certifications',
  'clients',
  'disciplines',
  'faq',
  'media',
  'navigation',
  'pages',
  'portfolio',
  'redirects',
  'sections',
  'sectors',
  'service-cases',
  'services',
  'statistics',
  'team',
  'testimonials',
  'themes',
];

const segmentOf = (pattern: string) => pattern.split('/')[2] ?? '';
/** An edit screen with no resource config, opened through its declared sample (C4b). */
const sampled = (pattern: string) => pattern in EDIT_SAMPLES;
const holds = (role: Role, cap: Capability, access: readonly string[]) =>
  access.includes(ROLE_CAPS[role][cap]);

describe('the sweep route map', () => {
  it('maps exactly the pinned resource segments', () => {
    expect(Object.keys(RESOURCE_BY_SEGMENT).sort()).toEqual(SEGMENTS);
  });

  it('every route resolves to a page file', () => {
    for (const role of ROLES) {
      for (const route of sweepRoutes(role)) {
        expect(() => pageFileFor(route.path), route.path).not.toThrow();
      }
    }
  });

  it('every create and edit screen belongs to a known resource whose API uses that config', () => {
    for (const route of sweepRoutes('admin').filter(
      (r) => r.kind !== 'screen' && !sampled(r.pattern),
    )) {
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
        const sample = EDIT_SAMPLES[route.pattern];
        if (sample) {
          // Its sample's list is a route with a capability of its own (C4b).
          expect(holds(role, sample.cap, ['full']), `${role} ${route.path}`).toBe(true);
          continue;
        }
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
    // An edit screen with no resource config has its row made by samples.setup.ts instead.
    for (const route of edits.filter(
      (r) => !((r.listApi ?? '') in UNSEEDED_LISTS) && !sampled(r.pattern),
    )) {
      const { table } = RESOURCE_BY_SEGMENT[segmentOf(route.pattern)]!.config;
      expect(seeds(table), `${route.pattern}: seed.sql inserts no ${table} row`).toBe(true);
    }
  });

  it('a role that may author a resource it sees is sent to its create screen', () => {
    for (const role of ROLES) {
      const routes = new Set(sweepRoutes(role).map((r) => r.path));
      for (const route of sweepRoutes(role).filter(
        (r) => r.kind === 'edit' && !sampled(r.pattern),
      )) {
        const segment = segmentOf(route.pattern);
        const { config } = RESOURCE_BY_SEGMENT[segment]!;
        let hasNew = true;
        try {
          pageFileFor(`/admin/${segment}/new`);
        } catch {
          hasNew = false;
        }
        if (
          hasNew &&
          holds(role, config.writeCap, ['full']) &&
          !(`/admin/${segment}/new` in REDIRECT_PAGES)
        ) {
          expect(routes, `${role} /admin/${segment}/new`).toContain(`/admin/${segment}/new`);
        }
      }
    }
  });

  it('a page that only redirects is not swept, and redirects where it says (U4)', () => {
    for (const [page, target] of Object.entries(REDIRECT_PAGES)) {
      const source = readFileSync(pageFileFor(page), 'utf8');
      expect(source, page).toContain(`return Astro.redirect('${target}', 302);`);
      for (const role of ROLES) {
        expect(
          sweepRoutes(role).map((r) => r.path),
          `${role} ${page}`,
        ).not.toContain(page);
      }
    }
  });

  it('opens an edit screen with no resource config through its declared sample (C4b)', () => {
    expect(Object.keys(EDIT_SAMPLES)).toEqual(['/admin/leads/[id]']);
    const setup = readFileSync('tests/admin/samples.setup.ts', 'utf8');
    expect(setup).toContain("import { EDIT_SAMPLES } from './routes'");
    for (const [pattern, sample] of Object.entries(EDIT_SAMPLES)) {
      expect(() => pageFileFor(pattern), pattern).not.toThrow();
      // A row no parallel test erases: the oldest, never the list's default (newest), which
      // tests/admin/leads.e2e.ts's erase test removes while the sweep runs.
      expect(sample.body['sort'], pattern).toBe('oldest');
      expect(sample.body['limit'], pattern).toBe(1);
      // The list and the create route exist and ask for the capability the sample names.
      for (const api of [sample.api, sample.create.api]) {
        const file = existsSync(`src/pages${api}.ts`)
          ? `src/pages${api}.ts`
          : `src/pages${api}/index.ts`;
        expect(existsSync(file), file).toBe(true);
        expect(readFileSync(file, 'utf8'), file).toContain(`cap: '${sample.cap}'`);
      }
      // Every role swept on it gets its id from that list, never from a resource's GET.
      for (const role of ROLES) {
        const route = sweepRoutes(role).find((r) => r.pattern === pattern);
        if (!route) continue;
        expect(route.listApi, role).toBe(sample.api);
        expect(route.sample, role).toBe(sample);
        expect(holds(role, sample.cap, ['full']), role).toBe(true);
      }
    }
    // The leads detail is swept for exactly the roles that work leads.
    expect(
      ROLES.filter((role) => sweepRoutes(role).some((r) => r.pattern === '/admin/leads/[id]')),
    ).toEqual(ROLES.filter((role) => ROLE_CAPS[role]['leads.manage'] === 'full'));
  });

  it('finds an edit screen’s row one way for the sweep and the capture (C4b)', () => {
    // A resource's edit screen: its GET list. The lead's page: its sample's POST (the list
    // route is POST only), never a GET that answers 405 and skips the screen.
    for (const role of ROLES) {
      for (const route of sweepRoutes(role)) {
        const request = editRowRequest(route);
        if (route.kind !== 'edit') {
          expect(request, route.path).toBeNull();
          continue;
        }
        const sample = EDIT_SAMPLES[route.pattern];
        expect(request, route.path).toEqual(
          sample
            ? { method: 'POST', url: sample.api, body: sample.body }
            : { method: 'GET', url: `${route.listApi}?limit=1` },
        );
      }
    }
    // Both specs that open an edit screen ask through it, so neither can drift back to a GET.
    for (const spec of ['tests/admin/sweep.e2e.ts', 'tests/admin/capture.e2e.ts']) {
      const source = readFileSync(spec, 'utf8');
      expect(source, spec).toContain('editRowRequest(route)');
      expect(source, spec).not.toMatch(/listApi\}\?limit=1/);
    }
  });

  it('Admin is swept on every sidebar link and tab, and the extras', () => {
    const paths = new Set(sweepRoutes('admin').map((r) => r.path));
    for (const screen of [...menuScreens(), ...EXTRA_LINKS]) {
      // A page that only redirects is not opened as a screen (the test below), only its
      // create and edit pages.
      if (screen.href in REDIRECT_PAGES) continue;
      expect(paths, screen.href).toContain(screen.href);
    }
    // U10: the redirects list moved to /admin/seo; its no-JS pages are still swept.
    expect(paths).toContain('/admin/redirects/new');
    expect(paths).toContain('/admin/redirects/[id]');
  });

  it('every tab of the Forms overview is swept for the roles that may open it (U11)', () => {
    for (const role of ROLES) {
      const paths = new Set(sweepRoutes(role).map((r) => r.path));
      for (const id of FORM_IDS) {
        const href = formsTabHref(id);
        if (ROLE_CAPS[role]['settings.general'] === 'full') {
          expect(paths, `${role} ${href}`).toContain(href);
        } else {
          expect(paths, `${role} ${href}`).not.toContain(href);
        }
      }
    }
  });

  it('every role is swept on its own account and bell pages (Admin v2 F8)', () => {
    for (const role of ROLES) {
      const paths = new Set(sweepRoutes(role).map((r) => r.path));
      expect(paths, role).toContain('/admin/account');
      expect(paths, role).toContain('/admin/notifications');
    }
  });

  it('every role is swept on the help centre: a screen, a search, a guide in each language (U16)', () => {
    for (const role of ROLES) {
      const paths = new Set(sweepRoutes(role).map((r) => r.path));
      for (const path of [
        '/admin/help?screen=/admin',
        '/admin/help?q=password',
        '/admin/help?guide=finding-your-way',
        '/admin/help?guide=finding-your-way&lang=ar',
      ]) {
        expect(paths, `${role} ${path}`).toContain(path);
      }
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

// tests/admin/refusals.e2e.ts opens each locked screen as every role without its capability.
// These keep that list honest: real screens and APIs, each refused to exactly the roles
// whose menu leaves it out, and refused to some role at all.
describe('the locked screens the refusals e2e opens', () => {
  it('are menu screens with a page and an API', () => {
    const hrefs = menuScreens().map((s) => s.href);
    for (const screen of LOCKED_SCREENS) {
      expect(hrefs, screen.href).toContain(screen.href);
      expect(() => pageFileFor(screen.href), screen.href).not.toThrow();
      const api = `src/pages${screen.api}`;
      expect(existsSync(`${api}.ts`) || existsSync(`${api}/index.ts`), api).toBe(true);
    }
  });

  it('are refused to exactly the roles whose menu leaves them out, never to Admin', () => {
    for (const screen of LOCKED_SCREENS) {
      const refused = refusedRoles(screen);
      expect(refused.length, screen.href).toBeGreaterThan(0);
      expect(refused, screen.href).not.toContain('admin');
      for (const role of ROLES) {
        expect(reachableHrefs(role).includes(screen.href), `${role} ${screen.href}`).toBe(
          !refused.includes(role),
        );
      }
    }
  });

  it('a server-rendered one refuses itself: a 403, the refusal, no island (U2)', () => {
    const server = LOCKED_SCREENS.filter((screen) => renderOf(screen) === 'server');
    expect(server.map((s) => s.href).sort()).toEqual([
      '/admin/analytics/search',
      '/admin/audit',
      '/admin/forms',
      '/admin/integrations',
      '/admin/leads',
      '/admin/leads/board',
      '/admin/maintenance',
      '/admin/seo',
      '/admin/settings',
      '/admin/site-health',
    ]);
    for (const screen of server) {
      const page = readFileSync(pageFileFor(screen.href), 'utf8');
      expect(page, screen.href).toContain(
        "import Refused from '@/components/admin/ui/Refused.astro'",
      );
      expect(page, screen.href).toMatch(/if \(!allowed\) Astro\.response\.status = 403;/);
      expect(page, screen.href).toContain(`can(session.role, '${screen.cap}') === 'full'`);
    }
    // An island screen loads its data on mount, so its page has no Refused of its own.
    for (const screen of LOCKED_SCREENS.filter((s) => renderOf(s) === 'island')) {
      expect(readFileSync(pageFileFor(screen.href), 'utf8'), screen.href).not.toContain('Refused');
    }
  });

  it('cover every role but Admin', () => {
    const covered = new Set(LOCKED_SCREENS.flatMap(refusedRoles));
    expect([...covered].sort()).toEqual(ROLES.filter((r) => r !== 'admin').sort());
  });
});

// An API whose screen became a tab of another screen (LOCKED_APIS) is asked directly, so the
// move does not take its negative e2e with it (CLAUDE.md §9; U10 review: the redirects list).
describe('the locked APIs the refusals e2e asks directly', () => {
  it('are resource lists refused for their own capability, to some role, never to Admin', () => {
    expect(LOCKED_APIS.length).toBeGreaterThan(0);
    for (const entry of LOCKED_APIS) {
      const api = `src/pages${entry.api}`;
      expect(existsSync(`${api}.ts`) || existsSync(`${api}/index.ts`), api).toBe(true);
      const resource = RESOURCE_BY_SEGMENT[entry.api.replace(/^\/api\/admin\//, '')];
      expect(resource, entry.api).toBeDefined();
      expect(resource!.config.readCaps ?? [resource!.config.writeCap], entry.api).toEqual([
        entry.cap,
      ]);
      const refused = refusedRoles(entry);
      expect(refused.length, entry.api).toBeGreaterThan(0);
      expect(refused, entry.api).not.toContain('admin');
    }
  });

  it('a list screen that now only redirects keeps its API in the refusals e2e (U10)', () => {
    const asked = new Set([...LOCKED_SCREENS, ...LOCKED_APIS].map((entry) => entry.api));
    let moved = 0;
    for (const page of Object.keys(REDIRECT_PAGES)) {
      const resource = RESOURCE_BY_SEGMENT[page.replace(/^\/admin\//, '')];
      if (!resource) continue; // not a list screen (/admin/media/new is an upload now)
      const { config } = resource;
      const caps = config.readCaps ?? [config.writeCap];
      const gated = ROLES.some((role) => caps.every((cap) => ROLE_CAPS[role][cap] === 'none'));
      if (!gated) continue;
      moved += 1;
      expect(asked, page).toContain(`/api${page}`);
    }
    // /admin/redirects (the SEO screen's Redirects tab since U10) is one.
    expect(moved).toBeGreaterThan(0);
  });
});

// Each role's sidebar, written out from the CLAUDE.md §5 matrix rather than computed: the
// sweep holds the sidebar the server renders to expectedSidebar(), so expectedSidebar()
// needs an oracle that is not the menu (src/lib/admin/nav) itself. A capability or menu
// change that alters what a role sees has to be made here too, on purpose.
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
      'FAQ /admin/faq',
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
      'Forms /admin/forms',
      'Notifications /admin/settings/notifications',
      'Integrations /admin/integrations',
      'Users & roles /admin/users',
      'Activity log /admin/audit',
      'CRM settings /admin/crm/settings',
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
      'FAQ /admin/faq',
      'Numbers /admin/statistics',
      'Certifications /admin/certifications',
      'Media library /admin/media',
    ],
    Growth: ['Website stats /admin/analytics', 'Style-Finder /admin/ai-questions'],
    Appearance: ['Menus /admin/navigation'],
    // Admin v2 U11: the bell's settings, every member's own.
    Settings: ['Notifications /admin/settings/notifications'],
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
    Settings: [
      'SEO /admin/seo',
      'Notifications /admin/settings/notifications',
      'Integrations /admin/integrations',
    ],
  },
  // Technical: media, leads, health, theme, settings, audit; no content, no applications.
  developer: {
    Overview: ['Dashboard /admin'],
    Content: ['Media library /admin/media'],
    CRM: ['Leads /admin/leads'],
    Growth: ['Website stats /admin/analytics', 'Site health /admin/site-health'],
    Appearance: ['Theme /admin/themes'],
    Settings: [
      'General /admin/settings',
      'Forms /admin/forms',
      'Notifications /admin/settings/notifications',
      'Activity log /admin/audit',
    ],
  },
  // Sales (C10a): works leads and reads the stats; no content, media, site settings or logs.
  // Its own bell's settings (Admin v2 U11) are every member's, as the account is.
  sales: {
    Overview: ['Dashboard /admin'],
    CRM: ['Leads /admin/leads'],
    Growth: ['Website stats /admin/analytics'],
    Settings: ['Notifications /admin/settings/notifications'],
  },
};

describe("the sweep's expected sidebar", () => {
  it.each(ROLES)('%s: the menu §5 gives the role, label and href', (role) => {
    expect(expectedSidebar(role)).toEqual(
      Object.entries(SIDEBAR[role]).map(([title, links]) => ({ title, links })),
    );
  });
});

// Playwright refuses a repeated test title when it collects the suites, and the whole e2e
// job then aborts before a single test runs (the sweep, axe and the CSP checks included).
// Every title the admin suites build from the route map is checked here instead.
describe('the e2e titles built from the route map are unique', () => {
  const repeated = (names: readonly string[]) => names.filter((n, i) => names.indexOf(n) !== i);

  it('the design capture: one name per role, viewport and route', () => {
    const names = ROLES.flatMap((role) =>
      CAPTURE_VIEWPORTS.flatMap((vp) =>
        captureRoutes(role).map((route) => captureName(role, vp.tag, route)),
      ),
    );
    expect(repeated(names)).toEqual([]);
  });

  it('the sweep: one title per route within each role', () => {
    for (const role of ROLES) {
      expect(repeated(sweepRoutes(role).map(routeKey)), role).toEqual([]);
    }
  });

  it('the help page’s four views are four captures, named by their query', () => {
    const help = captureRoutes('admin')
      .filter((route) => route.pattern === '/admin/help')
      .map((route) => captureName('admin', 'd', route));
    expect(help).toEqual([
      'admin-admin-d-admin_help_screen_admin',
      'admin-admin-d-admin_help_q_password',
      'admin-admin-d-admin_help_guide_finding-your-way',
      'admin-admin-d-admin_help_guide_finding-your-way_lang_ar',
    ]);
    expect(captureSlug('/admin/services/[id]')).toBe('admin_services_id');
    expect(captureSlug('/admin')).toBe('admin');
  });
});
