import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { WIDGET_IDS, type WidgetId } from '@schemas/dashboard';
import { CMS_ROLES, ROLES, type AuthContext, type Role } from '@/lib/auth/types';
import { CAPABILITIES, ROLE_CAPS, type Access, type Capability } from '@/lib/authz/matrix';
import {
  loadDashboard,
  perStudioDay as perRiyadhDay,
  studioDate as riyadhDate,
} from '@/lib/admin/dashboard/loaders';
import {
  DEFAULT_LAYOUTS,
  WIDGETS,
  widgetsFor,
  widgetsForCaps,
} from '@/lib/admin/dashboard/widgets';
import { visibleNav } from '@/lib/admin/nav';
import { loadShellState } from '@/lib/admin/shell';
import { studioTimeZone } from '@/lib/admin/studioTimeZone';

const { logs } = vi.hoisted(() => ({ logs: [] as unknown[] }));
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: unknown) => {
    logs.push(entry);
    return true;
  },
}));

// The dashboard's widget registry and loaders (Admin v2 U1). The headline rule (CLAUDE.md §3,
// ui.md AV-09): ROLE_CAPS decides which widgets a role has, and a widget the role cannot see
// is never loaded, so Content Creator and SEO never query leads or applications, not even
// for a count, whatever their stored layout names. Then: a hidden widget reads nothing, a
// failing read fails its own widget only (logged), "going live today" is the Riyadh day,
// and the whole render stays inside the Free plan's 50 subrequests (P-15).

const NOW = new Date('2026-10-16T09:00:00.000Z');

const auth = (role: Role): AuthContext => ({
  userId: 'u-1',
  tenantId: 't-1',
  role,
  isActive: true,
  email: 'amal.k@example.test',
});

interface Call {
  kind: 'from' | 'rpc';
  name: string;
  filters: [string, string, unknown][];
}

type TableAnswer = { rows?: unknown[]; row?: unknown; count?: number; error?: unknown };
type Answers = {
  tables?: Record<string, TableAnswer>;
  /** What a table the answers do not name returns (default: nothing). */
  otherTables?: TableAnswer;
  rpcs?: Record<string, { data?: unknown; error?: unknown }>;
};

/** A Supabase stand-in that answers per table and per RPC, and records every call. */
function fakeDb(answers: Answers = {}) {
  const calls: Call[] = [];
  const sb = {
    from(table: string) {
      const call: Call = { kind: 'from', name: table, filters: [] };
      calls.push(call);
      const answer = answers.tables?.[table] ?? answers.otherTables ?? {};
      const builder: Record<string, unknown> = {};
      for (const op of ['eq', 'neq', 'gte', 'lt', 'lte', 'in', 'is']) {
        builder[op] = (column: string, value: unknown) => {
          call.filters.push([op, column, value]);
          return builder;
        };
      }
      for (const op of ['select', 'order', 'limit', 'range', 'insert', 'update', 'delete']) {
        builder[op] = () => builder;
      }
      builder['maybeSingle'] = async () => ({
        data: answer.row ?? null,
        error: answer.error ?? null,
      });
      builder['then'] = (resolve: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
        Promise.resolve({
          data: answer.rows ?? [],
          count: answer.count ?? answer.rows?.length ?? 0,
          error: answer.error ?? null,
        }).then(resolve, reject);
      return builder;
    },
    async rpc(fn: string) {
      calls.push({ kind: 'rpc', name: fn, filters: [] });
      const answer = answers.rpcs?.[fn] ?? {};
      return { data: answer.data ?? null, error: answer.error ?? null };
    },
  };
  return { sb: sb as unknown as SupabaseClient, calls };
}

/** A stored layout naming every widget there is (what a crafted or stale preference could hold). */
const EVERYTHING = {
  top: ['kpis'],
  left: ['quick', 'views', 'leads', 'attention', 'health'],
  right: ['activity', 'applications', 'pages', 'disciplines', 'notes', 'realtime'],
  hidden: [],
};

const LEAD_TABLES = ['leads', 'lead_stages', 'job_applications'];
const LEAD_RPCS = ['lead_summary', 'leads_list'];

describe('the registry follows ROLE_CAPS', () => {
  it('names every widget id once, each with words', () => {
    expect(Object.keys(WIDGETS).sort()).toEqual([...WIDGET_IDS].sort());
    for (const id of WIDGET_IDS) {
      expect(WIDGETS[id].id).toBe(id);
      expect(WIDGETS[id].label).toMatch(/^[A-Z]/);
      expect(`${WIDGETS[id].label} ${WIDGETS[id].description}`).not.toMatch(/[–—]/);
    }
  });

  it.each([
    ['admin', [...WIDGET_IDS]],
    ['content_creator', ['kpis', 'quick', 'views', 'attention', 'pages', 'notes', 'realtime']],
    ['seo', ['kpis', 'quick', 'views', 'attention', 'pages', 'notes', 'realtime']],
    [
      'developer',
      [
        'kpis',
        'quick',
        'views',
        'leads',
        'health',
        'activity',
        'pages',
        'disciplines',
        'notes',
        'realtime',
      ],
    ],
  ] as [Role, WidgetId[]][])('%s', (role, widgets) => {
    expect(widgetsFor(role)).toEqual(widgets);
  });

  it('Content Creator and SEO never get a lead or application widget', () => {
    for (const role of ['content_creator', 'seo'] as const) {
      for (const id of ['leads', 'disciplines', 'applications'] as const) {
        expect(widgetsFor(role)).not.toContain(id);
      }
    }
  });

  it('a widget shows exactly where ROLE_CAPS holds one of its capabilities in full', () => {
    for (const role of ROLES) {
      for (const id of WIDGET_IDS) {
        const need = WIDGETS[id].anyCaps;
        const holds = need.length === 0 || need.some((cap) => ROLE_CAPS[role][cap] === 'full');
        expect(widgetsFor(role).includes(id), `${role} ${id}`).toBe(holds);
      }
    }
  });

  it('a role with no capability gets no widget at all (ui.md §10)', () => {
    const none = Object.fromEntries(CAPABILITIES.map((c) => [c, 'none'])) as Record<
      Capability,
      Access
    >;
    expect(widgetsForCaps(none)).toEqual([]);
  });

  it('every default layout uses only its role’s widgets, each once, and mentions all of them', () => {
    for (const role of ROLES) {
      const layout = DEFAULT_LAYOUTS[role];
      const ids = [...layout.top, ...layout.left, ...layout.right, ...layout.hidden];
      expect(new Set(ids).size, role).toBe(ids.length);
      expect([...ids].sort(), role).toEqual([...widgetsFor(role)].sort());
    }
  });
});

describe('the loaders read only what the role sees', () => {
  beforeEach(() => {
    logs.length = 0;
  });

  it.each(['content_creator', 'seo'] as const)(
    '%s never queries leads or applications, even with a layout naming them',
    async (role) => {
      const { sb, calls } = fakeDb({
        tables: {
          admin_user_prefs: { row: { dashboard: EVERYTHING, quick_actions: [], version: 3 } },
        },
      });
      const dashboard = await loadDashboard({
        sb,
        auth: auth(role),
        now: NOW,
        siteUrl: 'https://site.example',
      });
      expect(Object.keys(dashboard.widgets).sort()).toEqual([...widgetsFor(role)].sort());
      expect(calls.filter((c) => c.kind === 'from').map((c) => c.name)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^(leads|lead_stages|job_applications)$/)]),
      );
      for (const table of LEAD_TABLES)
        expect(
          calls.some((c) => c.name === table),
          table,
        ).toBe(false);
      for (const fn of LEAD_RPCS)
        expect(
          calls.some((c) => c.name === fn),
          fn,
        ).toBe(false);
      // No lead figure in what the page renders: the KPI row says pages and services instead.
      const kpis = dashboard.widgets.kpis;
      expect(kpis?.ok && kpis.data.map((k) => k.label)).toEqual([
        'Page views, 7 days',
        'Arabic share',
        'Pages live',
        'Services live',
      ]);
      const views = dashboard.widgets.views;
      expect(views?.ok && views.data.leads).toBeNull();
    },
  );

  // H13 (0100_attention_staff.sql): the attention view answers CMS staff only. The dashboard
  // asks it (widget and banner) only for a role holding a content capability, all CMS staff;
  // Developer and Sales never ask, whatever their stored layout names, so no screen of a
  // non-staff role depends on the view's empty answer.
  it.each(ROLES)(
    '%s asks the attention list only as CMS staff with a content role',
    async (role) => {
      const { sb, calls } = fakeDb({
        tables: {
          admin_user_prefs: { row: { dashboard: EVERYTHING, quick_actions: [], version: 3 } },
        },
      });
      const dashboard = await loadDashboard({
        sb,
        auth: auth(role),
        now: NOW,
        siteUrl: 'https://site.example',
      });
      const asks = calls.some((c) => c.name === 'dashboard_attention');
      expect(asks).toBe(['admin', 'content_creator', 'seo'].includes(role));
      expect(asks && !(CMS_ROLES as readonly string[]).includes(role)).toBe(false);
      expect('attention' in dashboard.widgets).toBe(asks);
      expect(dashboard.banners.placeholdersLive).toBe(0);
    },
  );

  it('Admin with every widget reads each, the lead figures included', async () => {
    const { sb, calls } = fakeDb({
      tables: {
        admin_user_prefs: { row: { dashboard: EVERYTHING, quick_actions: [], version: 3 } },
      },
      rpcs: { lead_summary: { data: { new: 4 } } },
    });
    const dashboard = await loadDashboard({
      sb,
      auth: auth('admin'),
      now: NOW,
      siteUrl: 'https://site.example',
    });
    expect(Object.keys(dashboard.widgets).sort()).toEqual([...WIDGET_IDS].sort());
    for (const id of WIDGET_IDS) expect(dashboard.widgets[id]?.ok, id).toBe(true);
    const kpis = dashboard.widgets.kpis;
    expect(kpis?.ok && kpis.data.find((k) => k.label === 'New leads waiting')?.value).toBe(4);
    expect(calls.some((c) => c.name === 'leads_list')).toBe(true);
    expect(calls.some((c) => c.name === 'job_applications')).toBe(true);
  });

  it('a hidden widget reads nothing: a board of quick actions alone reads no stats', async () => {
    const { sb, calls } = fakeDb({
      tables: {
        admin_user_prefs: {
          row: {
            dashboard: { top: [], left: ['quick'], right: [], hidden: ['kpis'], quickSet: true },
            quick_actions: [{ id: 'stats' }],
            version: 2,
          },
        },
      },
    });
    const dashboard = await loadDashboard({
      sb,
      auth: auth('developer'),
      now: NOW,
      siteUrl: 'https://site.example',
    });
    expect(Object.keys(dashboard.widgets)).toEqual(['quick']);
    // The preferences row alone: the layout and quick list are the person's own, so no preset
    // is read; no stats, lead, health or audit read; no homepage (no edit-home in the list,
    // and Developer cannot edit pages).
    expect(calls.map((c) => c.name)).toEqual(['admin_user_prefs']);
  });

  it('the preset is read only when the person’s own layout or quick list leaves a gap', async () => {
    const fresh = fakeDb({
      tables: {
        admin_role_defaults: {
          row: {
            role: 'seo',
            dashboard: { top: [], left: ['pages'], right: [], hidden: [] },
            quick_actions: [],
            version: 1,
            updated_at: null,
          },
        },
      },
    });
    const dashboard = await loadDashboard({
      sb: fresh.sb,
      auth: auth('seo'),
      now: NOW,
      siteUrl: 'https://site.example',
    });
    expect(fresh.calls.slice(0, 2).map((c) => c.name)).toEqual([
      'admin_user_prefs',
      'admin_role_defaults',
    ]);
    expect(dashboard.source).toBe('preset');
    expect(dashboard.layout.left).toEqual(['pages']);
  });

  it('a failing read fails its own widget only, and is logged', async () => {
    const { sb } = fakeDb({
      tables: {
        admin_user_prefs: { row: { dashboard: EVERYTHING, quick_actions: [], version: 1 } },
        audit_log: { error: { code: '57014', message: 'canceling statement due to timeout' } },
      },
    });
    const dashboard = await loadDashboard({
      sb,
      auth: auth('admin'),
      now: NOW,
      siteUrl: 'https://site.example',
    });
    expect(dashboard.widgets.activity).toEqual({ ok: false });
    expect(dashboard.widgets.applications?.ok).toBe(true);
    expect(dashboard.widgets.notes?.ok).toBe(true);
    // (Site health reads audit_log too, for the last backup, and says so in its own row.)
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'error',
          source: 'admin:dashboard',
          message: 'Dashboard widget activity could not be read',
        }),
      ]),
    );
    expect(dashboard.widgets.health?.ok).toBe(true);
  });

  it('a failed preferences read still shows the role’s layout, with editing off', async () => {
    const { sb } = fakeDb({
      tables: { admin_user_prefs: { error: { code: '42501', message: 'denied' } } },
    });
    const dashboard = await loadDashboard({
      sb,
      auth: auth('seo'),
      now: NOW,
      siteUrl: 'https://site.example',
    });
    expect(dashboard.prefs).toBeNull();
    expect(dashboard.source).toBe('default');
    expect(dashboard.layout.top).toEqual(['kpis']);
  });

  it('"Going live today" is the Riyadh day, read like the bell; the view’s UTC day is not used', async () => {
    const { sb, calls } = fakeDb({
      tables: {
        admin_user_prefs: {
          row: {
            dashboard: { top: [], left: ['attention'], right: [], hidden: [] },
            quick_actions: [],
            version: 1,
          },
        },
      },
    });
    // 22:30 UTC on the 15th is 01:30 on the 16th in Riyadh: "today" is the 16th there.
    await loadDashboard({
      sb,
      auth: auth('content_creator'),
      now: new Date('2026-10-15T22:30:00.000Z'),
      siteUrl: 'https://site.example',
    });
    const view = calls.find((c) => c.name === 'dashboard_attention');
    expect(view?.filters).toContainEqual(['neq', 'kind', 'scheduled_today']);
    const services = calls.find((c) => c.name === 'services');
    expect(services?.filters).toEqual(
      expect.arrayContaining([
        ['gte', 'scheduled_for', '2026-10-15T21:00:00.000Z'],
        ['lt', 'scheduled_for', '2026-10-16T21:00:00.000Z'],
      ]),
    );
  });

  it('counts per Riyadh day: an evening lead in UTC is the next morning’s in Riyadh', () => {
    expect(riyadhDate(Date.parse('2026-10-15T21:30:00.000Z'))).toBe('2026-10-16');
    const counted = perRiyadhDay(
      ['2026-10-15T21:30:00.000Z', '2026-10-15T20:30:00.000Z', '2026-10-16T08:00:00.000Z'],
      2,
      NOW,
    );
    expect(counted).toEqual({ days: ['2026-10-15', '2026-10-16'], counts: [1, 2] });
  });
});

/** The middleware's reads before the page runs: the session check (getUser), the profile row
 *  it is held to, and the identity row the layout renders. */
const MIDDLEWARE = 3;
/**
 * What the budget test measures; docs/admin-v2/as-built/U1.md records U1's figures (24, 34).
 * R5 (0066) added one read: stale pending changes are read on their own, with an exact count,
 * so they never crowd the content kinds out of the attention list's capped read. G2 added two:
 * the health widget's readings (health_probes, through loadHealthSummary) and the bell's health
 * source in the shell (docs/admin-v2/as-built/G2.md). G1b added one: the Right now widget's
 * realtime_summary (docs/admin-v2/as-built/G1.md). U17 added one, for users.manage only:
 * the health widget's two factor row reads the directory (staff_accounts). U9 added one: the
 * studio's time zone (public.studio_time_zone), which the page and the layout both ask for
 * and studioTimeZone reads once per request (docs/admin-v2/as-built/U9.md). R11 added one, in
 * the shell for every role that publishes: the bell's failed scheduled releases
 * (content_releases, docs/admin-v2/as-built/R11.md). R12 added one, in the shell for the four
 * CMS roles: whether releases are on for the tenant (public.releases_enabled), which decides
 * whether the savebar is drawn (docs/admin-v2/as-built/R12.md); 8 short of 50.
 */
const MEASURED = { loadDashboard: 28, total: 42 };

describe('the subrequest budget (README P-15: 50 on the Workers Free plan)', () => {
  // A real request has one clock: the dashboard's "Going live today" and the bell both ask
  // goingLiveToday(), which memoises its two reads per request client and Riyadh day, so they
  // are read once. The fixtures are dated, so the test must hold the clock there as well;
  // with the real clock the memo misses from the day after these fixtures onwards and the
  // shell pays those two reads again (the budget then measures 36, not 34).
  afterEach(() => {
    vi.useRealTimers();
  });

  it('Admin with every widget, page and shell together, stays well inside it', async () => {
    vi.setSystemTime(NOW);
    // Every table answers a row, so the reads that run only when there is data run too: the
    // activity's people lookup (audit_people), the disciplines' and the latest leads' labels
    // (services, disciplines), the scheduled items. An empty fake skips them and undercounts.
    const at = NOW.toISOString();
    const { sb, calls } = fakeDb({
      tables: {
        admin_user_prefs: {
          row: { dashboard: EVERYTHING, quick_actions: [{ id: 'edit-home' }], version: 1 },
        },
      },
      otherTables: {
        rows: [
          {
            id: 'r1',
            actor_id: 'u-2',
            actor_role: 'seo',
            action: 'service.update',
            entity_type: 'service',
            entity_id: 's1',
            detail: {},
            created_at: at,
            name: 'Sam',
            service_of_interest: 'logo',
            discipline_of_interest: 'branding',
            slug: 'branding',
            title: { en: 'Logo design', ar: 'تصميم الشعار' },
            status: 'scheduled',
            scheduled_for: at,
            updated_at: at,
          },
        ],
        count: 1,
      },
      rpcs: {
        leads_list: {
          data: {
            rows: [
              {
                id: 'l1',
                name: 'Sam',
                service_of_interest: 'logo',
                discipline_of_interest: 'branding',
                stage_id: null,
                created_at: NOW.toISOString(),
              },
            ],
          },
        },
      },
    });
    // The studio's zone: index.astro and AdminLayout.astro each ask studioTimeZone(Astro.locals),
    // which stores the read on the request's locals, so the two cost one subrequest.
    for (const file of ['src/pages/admin/index.astro', 'src/layouts/AdminLayout.astro']) {
      expect(readFileSync(file, 'utf8'), file).toContain('await studioTimeZone(Astro.locals)');
    }
    const locals = { supabase: sb, session: auth('admin') } as unknown as App.Locals;
    await studioTimeZone(locals);
    await studioTimeZone(locals);
    const zone = calls.length;
    expect(zone).toBe(1);
    await loadDashboard({ sb, auth: auth('admin'), now: NOW, siteUrl: 'https://site.example' });
    const page = calls.length - zone;
    await loadShellState(
      sb,
      auth('admin'),
      visibleNav('admin'),
      {},
      { maintenance: null, displayName: 'Amal' },
    );
    const shell = calls.length - zone - page;
    // The page's own read beside loadDashboard (src/pages/admin/index.astro): the greeting's
    // display name, one `sb.from(` there; the maintenance snapshot is a KV read, not a fetch.
    const indexPage = readFileSync('src/pages/admin/index.astro', 'utf8');
    const own = indexPage.match(/\bsb\s*\.\s*(from|rpc)\(/g)?.length ?? 0;
    expect(own).toBe(1);
    const byName = (from: number, to: number) =>
      calls
        .slice(from, to)
        .map((c) => c.name)
        .sort();
    // The reads that run only on data did run (the point of answering rows).
    expect(byName(zone, zone + page)).toEqual(
      expect.arrayContaining(['audit_people', 'disciplines', 'services']),
    );
    // The bell shares the dashboard's pair of "going live today" reads (the memo above), so
    // the shell asks neither table again.
    expect(byName(zone + page, calls.length)).not.toContain('services');
    expect(byName(zone + page, calls.length)).not.toContain('blog_posts');
    // Measured: recorded in docs/admin-v2/as-built/U1.md (the page, its own read, the shell;
    // then the middleware's session check and identity row, 3, must still leave room). The
    // message names every read, so a failure says which one is new instead of only by how much.
    const reads = `zone ${zone} + page ${page} [${byName(zone, zone + page).join(' ')}] + own ${own} + shell ${shell} [${byName(
      zone + page,
      calls.length,
    ).join(' ')}] + middleware ${MIDDLEWARE}`;
    expect(page, reads).toBeLessThanOrEqual(MEASURED.loadDashboard);
    expect(zone + own + page + shell + MIDDLEWARE, reads).toBeLessThanOrEqual(MEASURED.total);
    expect(MEASURED.total).toBeLessThanOrEqual(42);
  });
});
