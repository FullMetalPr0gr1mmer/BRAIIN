import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ROLES, type AuthContext, type Role } from '@/lib/auth/types';
import { can } from '@/lib/authz/matrix';
import { NOTIFICATION_KINDS } from '@schemas/adminPrefs';
import type { MaintenanceState } from '@/lib/http/maintenance';
import { NOTIFICATION_SOURCES, loadNotifications } from '@/lib/admin/notifications';
import { MAX_ITEMS, WINDOW_DAYS } from '@/lib/admin/notifications/types';
import { studioDay as riyadhDay } from '@/lib/admin/notifications/scheduled';

vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

// The bell (Admin v2 F8, docs/admin-v2/ui.md §2.8): a derived feed, filtered by ROLE_CAPS
// on the server before anything is read. The headline rule (CLAUDE.md §3, AV-05 tests):
// Content Creator and SEO get no lead or application item, not even a count, so the
// leads and job_applications tables are never even asked for them; Admin gets applications;
// a muted kind is dropped; what arrived after the watermark is unread.

const NOW = new Date('2026-10-10T12:00:00.000Z');
const TENANT = 't-1';
const USER = 'u-1';

const auth = (role: Role): AuthContext => ({
  userId: USER,
  tenantId: TENANT,
  role,
  isActive: true,
  email: 'person@example.test',
});

interface Query {
  table: string;
  select: string;
  filters: [op: string, column: string, value: unknown][];
}

type TableAnswer = { rows?: unknown[]; row?: unknown; error?: unknown };

/** A Supabase stand-in that answers each table and records every query it was asked. */
function fakeDb(tables: Record<string, TableAnswer> = {}) {
  const queries: Query[] = [];
  const sb = {
    from(table: string) {
      const query: Query = { table, select: '', filters: [] };
      queries.push(query);
      const answer = tables[table] ?? {};
      const builder: Record<string, unknown> = {
        select: (columns: string) => {
          query.select = columns;
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: answer.row ?? null, error: answer.error ?? null }),
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve({ data: answer.rows ?? [], error: answer.error ?? null }).then(
            resolve,
            reject,
          ),
      };
      for (const op of ['eq', 'neq', 'gte', 'lt', 'in']) {
        builder[op] = (column: string, value: unknown) => {
          query.filters.push([op, column, value]);
          return builder;
        };
      }
      return builder;
    },
  };
  return { sb: sb as unknown as SupabaseClient, queries };
}

const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const LEAD = {
  id: 'l-1',
  name: 'Sara',
  service_of_interest: 'logo',
  discipline_of_interest: null,
  created_at: ago(30),
};
const APPLICATION = { id: 'a-1', role: 'Motion designer', created_at: ago(60) };
// Goes live at 18:00 Riyadh time today; scheduled yesterday, so it is no news after a
// look at the bell this morning.
const SCHEDULED = {
  id: 's-1',
  title: { en: 'Logo Design', ar: 'تصميم الشعار' },
  scheduled_for: '2026-10-10T15:00:00.000Z',
  updated_at: '2026-10-09T08:00:00.000Z',
};

/** Every source has something to say, so what a role gets is decided by visibility alone. */
const FULL: Record<string, TableAnswer> = {
  leads: { rows: [LEAD] },
  job_applications: { rows: [APPLICATION] },
  services: { rows: [SCHEDULED] },
  blog_posts: { rows: [] },
  admin_user_prefs: { row: null },
};

const maintenanceOn = (changedAt: string | undefined) => async (): Promise<MaintenanceState> => ({
  active: true,
  allowlist: ['203.0.113.9'],
  ...(changedAt ? { changedAt } : {}),
});

const noMaintenance = async (): Promise<MaintenanceState | null> => ({
  active: false,
  allowlist: [],
});

describe('the bell: who gets what', () => {
  it('each kind has one source, registered under its own name', () => {
    expect(Object.keys(NOTIFICATION_SOURCES).sort()).toEqual([...NOTIFICATION_KINDS].sort());
    for (const kind of NOTIFICATION_KINDS) expect(NOTIFICATION_SOURCES[kind].kind).toBe(kind);
  });

  it('visibility follows ROLE_CAPS (CLAUDE.md §5), never a list of roles', () => {
    for (const role of ROLES) {
      expect(NOTIFICATION_SOURCES.leads.visible(role), role).toBe(
        can(role, 'leads.manage') === 'full',
      );
      expect(NOTIFICATION_SOURCES.applications.visible(role), role).toBe(
        can(role, 'applications.manage') === 'full',
      );
      expect(NOTIFICATION_SOURCES.scheduled.visible(role), role).toBe(
        can(role, 'services.write') === 'full' || can(role, 'blog.write') === 'full',
      );
      expect(NOTIFICATION_SOURCES.maintenance.visible(role), role).toBe(true);
    }
  });

  it('Content Creator and SEO: no lead or application item, and those tables are never asked', async () => {
    for (const role of ['content_creator', 'seo'] as const) {
      const { sb, queries } = fakeDb(FULL);
      const feed = await loadNotifications(sb, auth(role), {
        maintenance: maintenanceOn(ago(5)),
        labels: true,
        now: NOW,
      });
      const tables = queries.map((q) => q.table);
      expect(tables, role).not.toContain('leads');
      expect(tables, role).not.toContain('job_applications');
      expect(
        feed.items.filter((item) => item.kind === 'leads' || item.kind === 'applications'),
        role,
      ).toEqual([]);
      // Not even a count: the unread number is made of what the role may see.
      expect(feed.unread, role).toBe(feed.items.filter((item) => item.unread).length);
    }
  });

  it('what each role is shown, kind by kind', async () => {
    const expected: Record<Role, string[]> = {
      admin: ['applications', 'leads', 'maintenance', 'scheduled'],
      content_creator: ['maintenance', 'scheduled'],
      seo: ['maintenance'],
      developer: ['leads', 'maintenance'],
    };
    for (const role of ROLES) {
      const { sb } = fakeDb(FULL);
      const feed = await loadNotifications(sb, auth(role), {
        maintenance: maintenanceOn(ago(5)),
        now: NOW,
      });
      expect([...new Set(feed.items.map((item) => item.kind))].sort(), role).toEqual(
        expected[role],
      );
    }
  });

  it('Admin gets the applications; Developer, who works leads, does not', async () => {
    const admin = await loadNotifications(fakeDb(FULL).sb, auth('admin'), {
      maintenance: noMaintenance,
      now: NOW,
    });
    expect(admin.items.find((item) => item.kind === 'applications')).toMatchObject({
      text: 'New application for Motion designer',
      href: '/admin/applications',
      detail: null,
    });

    const { sb, queries } = fakeDb(FULL);
    const developer = await loadNotifications(sb, auth('developer'), {
      maintenance: noMaintenance,
      now: NOW,
    });
    expect(queries.map((q) => q.table)).not.toContain('job_applications');
    expect(developer.items.map((item) => item.kind)).toContain('leads');
  });
});

describe('the bell: what an item says', () => {
  it('a lead names the person and the interest the list shows, never contact details or the message', async () => {
    const { sb, queries } = fakeDb({
      ...FULL,
      services: {
        rows: [
          { slug: 'logo', title: { en: 'Logo Design', ar: 'تصميم الشعار' }, status: 'published' },
        ],
      },
    });
    const feed = await loadNotifications(sb, auth('admin'), {
      maintenance: noMaintenance,
      labels: true,
      now: NOW,
    });
    expect(feed.items.find((item) => item.kind === 'leads')).toMatchObject({
      id: 'leads:l-1',
      text: 'New inquiry from Sara',
      detail: 'Logo Design',
      // The lead's own page (C4b).
      href: '/admin/leads/l-1',
    });
    // Exactly these columns: no contact detail, budget, timeline, message, IP or note.
    const leadQuery = queries.find((q) => q.table === 'leads')!;
    expect(leadQuery.select.split(',').sort()).toEqual([
      'created_at',
      'discipline_of_interest',
      'id',
      'name',
      'service_of_interest',
    ]);
  });

  it('every row read names the tenant, leaves spam out and stays inside the window', async () => {
    const { sb, queries } = fakeDb(FULL);
    await loadNotifications(sb, auth('admin'), { maintenance: noMaintenance, now: NOW });
    const since = new Date(NOW.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
    const leads = queries.find((q) => q.table === 'leads')!;
    expect(leads.filters).toEqual(
      expect.arrayContaining([
        ['eq', 'tenant_id', TENANT],
        ['eq', 'is_spam', false],
        ['gte', 'created_at', since],
      ]),
    );
    const applications = queries.find((q) => q.table === 'job_applications')!;
    expect(applications.select).toBe('id,role,created_at');
    expect(applications.filters).toEqual(
      expect.arrayContaining([
        ['eq', 'tenant_id', TENANT],
        ['neq', 'status', 'spam'],
        ['gte', 'created_at', since],
      ]),
    );
    const prefs = queries.find((q) => q.table === 'admin_user_prefs')!;
    expect(prefs.filters).toEqual([
      ['eq', 'tenant_id', TENANT],
      ['eq', 'user_id', USER],
    ]);
  });

  it('the shell count skips the labels read; the drawer resolves them', async () => {
    // The labels read is the lead interests' slug lookup (the scheduled source reads the
    // services table too, for what goes live today, so the table alone does not tell).
    const labelReads = (queries: Query[]) =>
      queries.filter((q) => q.filters.some(([op, column]) => op === 'in' && column === 'slug'));

    const counted = fakeDb(FULL);
    await loadNotifications(counted.sb, auth('admin'), { maintenance: noMaintenance, now: NOW });
    expect(labelReads(counted.queries)).toEqual([]);

    const listed = fakeDb(FULL);
    await loadNotifications(listed.sb, auth('admin'), {
      maintenance: noMaintenance,
      labels: true,
      now: NOW,
    });
    expect(labelReads(listed.queries).map((q) => q.table)).toContain('services');
  });

  it('a scheduled service or post links to its editor, at its Riyadh time', async () => {
    const post = {
      id: 'b-1',
      title: { en: 'Brand week', ar: 'أسبوع العلامة' },
      scheduled_for: '2026-10-10T09:30:00.000Z',
      updated_at: '2026-10-08T10:00:00.000Z',
    };
    const { sb } = fakeDb({ ...FULL, blog_posts: { rows: [post] } });
    const feed = await loadNotifications(sb, auth('content_creator'), {
      maintenance: noMaintenance,
      now: NOW,
    });
    expect(feed.items.filter((item) => item.kind === 'scheduled')).toEqual([
      expect.objectContaining({
        id: 'scheduled:service:s-1',
        text: 'Logo Design goes live today',
        detail: 'At 18:00, Riyadh time',
        href: '/admin/services/s-1',
      }),
      expect.objectContaining({
        id: 'scheduled:blog_post:b-1',
        text: 'Brand week goes live today',
        detail: 'At 12:30, Riyadh time',
        href: '/admin/blog/b-1',
      }),
    ]);
  });

  it("'today' is the Riyadh day: both tables are read between its two midnights", async () => {
    // 12:00 UTC is 15:00 in Riyadh: the day runs from 21:00 UTC the evening before.
    const { sb, queries } = fakeDb(FULL);
    await loadNotifications(sb, auth('admin'), { maintenance: noMaintenance, now: NOW });
    for (const table of ['services', 'blog_posts']) {
      const read = queries.find((q) => q.table === table && q.select.includes('scheduled_for'));
      expect(read?.filters, table).toEqual([
        ['eq', 'tenant_id', TENANT],
        ['eq', 'status', 'scheduled'],
        ['gte', 'scheduled_for', '2026-10-09T21:00:00.000Z'],
        ['lt', 'scheduled_for', '2026-10-10T21:00:00.000Z'],
      ]);
    }
    // At 22:30 UTC it is already 01:30 tomorrow in Riyadh: the UTC date would still say
    // the 10th and call its last hours "today".
    expect(riyadhDay(new Date('2026-10-10T22:30:00.000Z'))).toEqual({
      start: '2026-10-10T21:00:00.000Z',
      end: '2026-10-11T21:00:00.000Z',
    });
    expect(riyadhDay(new Date('2026-10-10T20:59:59.999Z')).start).toBe('2026-10-09T21:00:00.000Z');
  });

  it('a post scheduled after the bell was read lights it again; an older one does not', async () => {
    // Read at 11:15 UTC. One post was moved to today at 11:50, after that; the service was
    // scheduled yesterday, so it counts from the day's start, before the read.
    const moved = {
      id: 'b-2',
      title: 'Launch notes',
      scheduled_for: '2026-10-10T16:00:00.000Z',
      updated_at: ago(10),
    };
    const { sb } = fakeDb({
      ...FULL,
      blog_posts: { rows: [moved] },
      admin_user_prefs: {
        row: { notifications: {}, notifications_seen_at: ago(45), version: 3 },
      },
    });
    const feed = await loadNotifications(sb, auth('content_creator'), {
      maintenance: noMaintenance,
      now: NOW,
    });
    const unread = Object.fromEntries(
      feed.items.filter((i) => i.kind === 'scheduled').map((i) => [i.id, i.unread]),
    );
    expect(unread).toEqual({
      'scheduled:service:s-1': false,
      'scheduled:blog_post:b-2': true,
    });
  });

  it('maintenance: an item for a recent switch, linked only for those who may flip it', async () => {
    for (const role of ROLES) {
      const feed = await loadNotifications(fakeDb(FULL).sb, auth(role), {
        maintenance: maintenanceOn(ago(5)),
        now: NOW,
      });
      const item = feed.items.find((i) => i.kind === 'maintenance');
      expect(item?.text, role).toBe('Maintenance mode was turned on');
      expect(item?.href ?? null, role).toBe(
        can(role, 'maintenance.manage') === 'full' ? '/admin/maintenance' : null,
      );
      // The allowlist never reaches the bell.
      expect(JSON.stringify(feed), role).not.toContain('203.0.113.9');
    }
  });

  it('maintenance: nothing for a switch older than the window, or one never stamped', async () => {
    const old = ago((WINDOW_DAYS + 1) * 24 * 60);
    for (const changedAt of [old, undefined]) {
      const feed = await loadNotifications(fakeDb(FULL).sb, auth('admin'), {
        maintenance: maintenanceOn(changedAt),
        now: NOW,
      });
      expect(feed.items.map((i) => i.kind)).not.toContain('maintenance');
    }
  });
});

describe('the bell: read, muted, failed, capped', () => {
  it('with no watermark everything is unread; after it, only what arrived later', async () => {
    const fresh = await loadNotifications(fakeDb(FULL).sb, auth('admin'), {
      maintenance: maintenanceOn(ago(5)),
      now: NOW,
    });
    expect(fresh.seenAt).toBeNull();
    expect(fresh.unread).toBe(fresh.items.length);

    // Read 45 minutes ago: the lead (30 min) and the switch (5 min) are new, the
    // application (60 min) is not. The scheduled item, scheduled yesterday, counts from the
    // start of its Riyadh day.
    const { sb } = fakeDb({
      ...FULL,
      admin_user_prefs: {
        row: { notifications: {}, notifications_seen_at: ago(45), version: 3 },
      },
    });
    const feed = await loadNotifications(sb, auth('admin'), {
      maintenance: maintenanceOn(ago(5)),
      now: NOW,
    });
    const unread = Object.fromEntries(feed.items.map((i) => [i.kind, i.unread]));
    expect(unread).toEqual({
      leads: true,
      maintenance: true,
      applications: false,
      scheduled: false,
    });
    expect(feed.unread).toBe(2);
    expect(feed.seenAt).toBe(ago(45));
  });

  it('says when the list was read, so "Mark all as read" marks only what it showed', async () => {
    const feed = await loadNotifications(fakeDb(FULL).sb, auth('admin'), {
      maintenance: noMaintenance,
      now: NOW,
    });
    expect(feed.asOf).toBe(NOW.toISOString());

    // The database stamps most items; a clock ahead of the Worker's still has its item
    // covered by the list it was shown in.
    const ahead = new Date(NOW.getTime() + 2_000).toISOString();
    const skewed = await loadNotifications(
      fakeDb({ ...FULL, leads: { rows: [{ ...LEAD, created_at: ahead }] } }).sb,
      auth('admin'),
      { maintenance: noMaintenance, now: NOW },
    );
    expect(skewed.asOf).toBe(ahead);
  });

  it('a muted kind is neither listed nor counted; an unknown muted kind is ignored', async () => {
    const { sb } = fakeDb({
      ...FULL,
      admin_user_prefs: {
        row: {
          notifications: { muted: ['leads', 'a-kind-from-a-later-slice'] },
          notifications_seen_at: null,
          version: 2,
        },
      },
    });
    const feed = await loadNotifications(sb, auth('admin'), {
      maintenance: noMaintenance,
      now: NOW,
    });
    expect(feed.items.map((i) => i.kind)).not.toContain('leads');
    expect(feed.items.map((i) => i.kind)).toContain('applications');
    expect(feed.unread).toBe(feed.items.length);
  });

  it('a source that fails is named and left out; the rest still arrive', async () => {
    const { sb } = fakeDb({ ...FULL, leads: { error: { message: 'boom' } } });
    const feed = await loadNotifications(sb, auth('admin'), {
      maintenance: noMaintenance,
      now: NOW,
    });
    expect(feed.failed).toEqual(['leads']);
    expect(feed.items.map((i) => i.kind)).toContain('applications');
  });

  it('a preferences read that fails mutes nothing and marks everything unread', async () => {
    const { sb } = fakeDb({ ...FULL, admin_user_prefs: { error: { message: 'down' } } });
    const feed = await loadNotifications(sb, auth('admin'), {
      maintenance: noMaintenance,
      now: NOW,
    });
    expect(feed.seenAt).toBeNull();
    expect(feed.unread).toBe(feed.items.length);
    expect(feed.failed).toEqual([]);
  });

  it(`lists at most ${MAX_ITEMS}, newest first`, async () => {
    const leads = Array.from({ length: 40 }, (_, i) => ({
      ...LEAD,
      id: `l-${i}`,
      created_at: ago(i + 1),
    }));
    const { sb } = fakeDb({ ...FULL, leads: { rows: leads } });
    const feed = await loadNotifications(sb, auth('admin'), {
      maintenance: noMaintenance,
      now: NOW,
    });
    expect(feed.items).toHaveLength(MAX_ITEMS);
    const times = feed.items.map((i) => Date.parse(i.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});

// ── Site health in the bell (Admin v2 G2, decision D5) ──────────────────────────────────

const probeRow = (
  kind: string,
  state: string,
  facts: unknown,
  over: Record<string, unknown> = {},
) => ({
  kind,
  state,
  facts,
  read_ok: true,
  failures: 0,
  checked_at: ago(5),
  ok_at: ago(5),
  next_at: ago(-5),
  state_since: ago(40),
  ...over,
});
const UPTIME_DOWN = {
  ratio30: 99.5,
  ratio90: 99.8,
  days: [],
  incidents: [
    { id: 'm-9', start: ago(40), durationSec: 1800, reason: 'Timeout', seenAt: ago(35) },
    {
      id: 'm-8',
      start: ago(60 * 24 * 20),
      durationSec: 600,
      reason: 'Old',
      seenAt: ago(60 * 24 * 20),
    },
  ],
  responseTimes: [],
  monitors: [
    { name: 'Arabic', path: '/ar/', intervalSec: 300, status: 'down' },
    { name: 'Home', path: '/', intervalSec: 300, status: 'up' },
  ],
  downSince: ago(40),
};
const HEALTH_FAIL: Record<string, TableAnswer> = {
  ...FULL,
  health_probes: {
    rows: [
      probeRow('uptime', 'fail', UPTIME_DOWN),
      probeRow(
        'domain',
        'fail',
        {
          apex: 'braiinstation.com',
          outcome: 'not-found',
          expires: null,
          registrar: null,
          rdap: null,
        },
        { state_since: ago(60 * 24) },
      ),
      probeRow(
        'certificate',
        'fail',
        {
          source: 'monitor',
          expires: new Date(NOW.getTime() + 10 * 86_400_000 + 3_600_000).toISOString(),
          issuer: 'R11',
        },
        { state_since: ago(60 * 3) },
      ),
    ],
  },
};

describe('the bell: site health (G2)', () => {
  it('runs for siteHealth.view roles only: Content Creator and SEO never ask', async () => {
    for (const role of ROLES) {
      expect(NOTIFICATION_SOURCES.health.visible(role), role).toBe(
        can(role, 'siteHealth.view') === 'full',
      );
      const { sb, queries } = fakeDb(HEALTH_FAIL);
      const feed = await loadNotifications(sb, auth(role), {
        maintenance: noMaintenance,
        now: NOW,
      });
      const asked = queries.some((q) => q.table === 'health_probes');
      const shown = feed.items.some((item) => item.kind === 'health');
      const may = can(role, 'siteHealth.view') === 'full';
      expect(asked, role).toBe(may);
      expect(shown, role).toBe(may);
    }
  });

  it('one read, for the tenant: down, the outage in the window, the domain, the certificate', async () => {
    const { sb, queries } = fakeDb(HEALTH_FAIL);
    const feed = await loadNotifications(sb, auth('developer'), {
      maintenance: noMaintenance,
      now: NOW,
    });
    const reads = queries.filter((q) => q.table === 'health_probes');
    expect(reads).toHaveLength(1);
    expect(reads[0]!.filters).toEqual([['eq', 'tenant_id', TENANT]]);
    const health = feed.items.filter((item) => item.kind === 'health');
    expect(health.map((item) => [item.id, item.text, item.href])).toEqual([
      [`health:incident:m-9`, 'The site was down for 30 minutes', '/admin/site-health'],
      [`health:uptime:${ago(40)}`, 'The site is down', '/admin/site-health'],
      [
        `health:certificate:${ago(180)}`,
        'The certificate expires in 10 days',
        '/admin/site-health?tab=security',
      ],
      [
        `health:domain:${ago(60 * 24)}`,
        'No registration found for braiinstation.com',
        '/admin/site-health?tab=security',
      ],
    ]);
    expect(health.find((item) => item.text === 'The site is down')?.detail).toBe('Monitor: /ar/');
  });

  it('a slow month is not an item; a stale probe is, once, from when it went stale', async () => {
    const { sb } = fakeDb({
      ...FULL,
      health_probes: {
        rows: [
          probeRow('uptime', 'warn', {
            ...UPTIME_DOWN,
            incidents: [],
            monitors: [],
            downSince: null,
          }),
          probeRow('domain', 'unknown', null, {
            failures: 6,
            read_ok: false,
            ok_at: ago(70),
            state_since: ago(10),
          }),
          probeRow('certificate', 'off', {}, { failures: 9 }),
        ],
      },
    });
    const feed = await loadNotifications(sb, auth('admin'), {
      maintenance: noMaintenance,
      now: NOW,
    });
    const health = feed.items.filter((item) => item.kind === 'health');
    expect(health).toHaveLength(1);
    expect(health[0]).toMatchObject({
      id: `health:stale:domain:${ago(70)}`,
      at: ago(10),
      href: '/admin/site-health',
    });
    expect(health[0]!.text).toMatch(/^The domain's registration record has not answered since /);
  });

  it('ids are stable across loads, and a new failure lights the dot after a look at the bell', async () => {
    const first = await loadNotifications(fakeDb(HEALTH_FAIL).sb, auth('admin'), {
      maintenance: noMaintenance,
      now: NOW,
    });
    const later = await loadNotifications(fakeDb(HEALTH_FAIL).sb, auth('admin'), {
      maintenance: noMaintenance,
      now: new Date(NOW.getTime() + 600_000),
    });
    const ids = (feed: typeof first) =>
      feed.items.filter((i) => i.kind === 'health').map((i) => i.id);
    expect(ids(later)).toEqual(ids(first));
    // Read 20 minutes ago: the outage first seen 35 minutes ago is old news; the certificate
    // and the domain, older still; the site going down 40 minutes ago too.
    const { sb } = fakeDb({
      ...HEALTH_FAIL,
      admin_user_prefs: { row: { notifications_seen_at: ago(20), notifications: {} } },
    });
    const seen = await loadNotifications(sb, auth('admin'), {
      maintenance: noMaintenance,
      now: NOW,
    });
    expect(seen.items.filter((i) => i.kind === 'health' && i.unread)).toEqual([]);
  });

  it('a domain or certificate renewed since the last read rings nothing (judged again now)', async () => {
    const later = new Date(NOW.getTime() + 400 * 86_400_000).toISOString();
    const { sb } = fakeDb({
      ...FULL,
      health_probes: {
        rows: [
          probeRow('domain', 'fail', {
            apex: 'braiinstatiion.com',
            outcome: 'ok',
            expires: later,
            registrar: null,
            rdap: null,
          }),
          probeRow('certificate', 'fail', { source: 'monitor', expires: later, issuer: null }),
        ],
      },
    });
    const feed = await loadNotifications(sb, auth('admin'), {
      maintenance: noMaintenance,
      now: NOW,
    });
    expect(feed.items.filter((item) => item.kind === 'health')).toEqual([]);
  });

  it('muting health drops its items', async () => {
    const { sb } = fakeDb({
      ...HEALTH_FAIL,
      admin_user_prefs: { row: { notifications: { muted: ['health'] } } },
    });
    const feed = await loadNotifications(sb, auth('admin'), {
      maintenance: noMaintenance,
      now: NOW,
    });
    expect(feed.items.filter((item) => item.kind === 'health')).toEqual([]);
  });
});
