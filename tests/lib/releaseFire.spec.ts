import { beforeEach, describe, expect, it, vi } from 'vitest';

// The minute schedule's fire step (Admin v2 R11, src/lib/cron/releases.ts): one claim of a due
// scheduled release (leased in the database), the Worker's check of the scheduler against
// ROLE_CAPS, `apply_release` in fire mode as them, the after-effects as the system, and a
// failure recorded closed. A minute that published a release runs no purge retries; any other
// runs them. Each path's worst case stays within the subrequests the job declares, and the
// job within the Free plan's 50.

const state = vi.hoisted(() => ({
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  reads: [] as string[],
  answers: {} as Record<string, () => { data: unknown; error: unknown }>,
  logs: [] as Record<string, unknown>[],
  snapshotRequests: 0,
  snapshotsFail: false,
}));

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.calls.push({ fn, args });
      const answer = () =>
        Promise.resolve().then(
          () =>
            state.answers[fn]?.() ?? {
              data: null,
              error: { code: 'XX000', message: `unexpected ${fn}` },
            },
        );
      return {
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => answer().then(ok, ko),
        abortSignal: () => answer(),
      };
    },
    // The slugs of the release's pages, read as the system (systemSlugs): one read a table.
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in']) b[m] = () => b;
      b['then'] = (ok: (v: unknown) => unknown) => {
        state.reads.push(table);
        return Promise.resolve({ data: [], error: null }).then(ok);
      };
      return b;
    },
  }),
}));
vi.mock('@/lib/supabase/client', () => ({ supabaseConfigured: () => true }));
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: Record<string, unknown>) => {
    state.logs.push(entry);
    return true;
  },
}));
vi.mock('@/lib/admin/redirectSync', () => ({
  syncRedirectsOfTenant: async () => {
    state.snapshotRequests += 2;
    if (state.snapshotsFail) {
      state.logs.push({ level: 'error', source: 'admin:redirect.sync', message: 'down' });
      return { kvSynced: false, count: 0, truncated: false };
    }
    return { kvSynced: true, count: 1, truncated: false };
  },
}));
vi.mock('@/lib/admin/visibilitySync', () => ({
  rebuildVisibilitySnapshot: async () => {
    state.snapshotRequests += 4;
    if (state.snapshotsFail) throw new Error('read page_visibility: down');
    return { snapshot: {}, kvSynced: true };
  },
}));

const {
  fireDueRelease,
  runReleaseMinute,
  RELEASE_JOBS,
  RELEASE_FIRE_LIMIT,
  RELEASE_FIRE_LEASE_MINUTES,
  RELEASE_FIRE_PUBLISHED_BUDGET,
  RELEASE_FIRE_FAILED_BUDGET,
  RELEASE_PURGE_BUDGET,
  RELEASE_MINUTE_BUDGET,
} = await import('@/lib/cron/releases');
const { resetPurgeBreaker } = await import('@/lib/http/purge');
const { runJobs } = await import('@/lib/cron/daily');

const T = '00000000-0000-4000-8000-0000000000b1';
const REL = '0e0e0e0e-0000-4000-8000-000000000050';
const USER = '0e0e0e0e-0000-4000-8000-0000000000a1';
const DRAFT = '0e0e0e0e-0000-4000-8000-0000000000d1';
const PAGE = '0e0e0e0e-0000-4000-8000-0000000000c1';

const due = (over: Record<string, unknown> = {}) => ({
  tenant_id: T,
  release_id: REL,
  scheduled_for: '2026-10-23T10:00:00+00:00',
  scheduled_by: USER,
  kind: 'publish',
  scheduler: { role: 'content_creator', tenant_id: T, live: true },
  items: [{ entity_type: 'service', op: 'update', status: null }],
  ...over,
});
const ok = (data: unknown) => () => ({ data, error: null });
const item = (entityType: string, over: Record<string, unknown> = {}) => ({
  id: 1,
  tenant_id: T,
  release_id: REL,
  entity_type: entityType,
  entity_id: PAGE,
  op: 'update',
  before: { slug: 'about' },
  after: { slug: 'about' },
  draft_id: DRAFT,
  actor_id: USER,
  created_at: '2026-10-23T10:00:01+00:00',
  ...over,
});
const live = (
  items: unknown[] = [item('service', { before: { slug: 'logo' }, after: { slug: 'logo' } })],
) => ok({ release_id: REL, number: 4, items });

const calls = (fn: string) => state.calls.filter((c) => c.fn === fn);

const fetched: string[] = [];
function zone(...answers: Response[]) {
  return {
    config: { zoneId: '0123456789abcdef0123456789abcdef', token: 'purge-token' },
    fetchImpl: (async (_url: string, init: RequestInit) => {
      fetched.push(String(init.body));
      const next = answers.shift();
      if (!next) throw new Error('unexpected fetch');
      return next;
    }) as unknown as typeof fetch,
    sleep: async () => undefined,
    random: () => 0.5,
  };
}

beforeEach(() => {
  state.calls = [];
  state.reads = [];
  state.logs = [];
  state.snapshotRequests = 0;
  state.snapshotsFail = false;
  state.answers = {
    claim_scheduled_releases: ok([]),
    claim_release_purges: ok([]),
    record_release_purge: ok(null),
    fail_scheduled_release: ok({ failed: true, status: 'failed', released: 1 }),
    cache_purge_take: ok(true),
  };
  fetched.length = 0;
  resetPurgeBreaker();
});

describe('a minute with nothing due (every minute while releases are off)', () => {
  it('is two claims, one of each kind: nothing fired, purged or logged', async () => {
    await runReleaseMinute();
    expect(state.calls.map((c) => c.fn)).toEqual([
      'claim_scheduled_releases',
      'claim_release_purges',
    ]);
    expect(calls('claim_scheduled_releases')[0]!.args).toEqual({ p_limit: RELEASE_FIRE_LIMIT });
    expect(state.logs).toEqual([]);
    expect(RELEASE_FIRE_LIMIT).toBe(1);
    expect(RELEASE_FIRE_LEASE_MINUTES).toBe(2);
  });
});

describe('a due release goes live as its scheduler', () => {
  it('apply_release in fire mode, the scheduler and their live role, nothing else', async () => {
    state.answers['claim_scheduled_releases'] = ok([due()]);
    state.answers['apply_release'] = live();
    const run = await fireDueRelease();
    expect(run).toMatchObject({
      outcome: 'published',
      releaseId: REL,
      number: 4,
      purge: 'skipped',
    });
    expect(calls('apply_release').map((c) => c.args)).toEqual([
      {
        p_actor: USER,
        p_role: 'content_creator',
        p_mode: 'fire',
        p_items: null,
        p_release_id: REL,
      },
    ]);
  });

  it('its after-effects as the system: the purge recorded, one line, and no purge retries that minute', async () => {
    state.answers['claim_scheduled_releases'] = ok([due()]);
    state.answers['apply_release'] = live();
    const { fire, purges } = await runReleaseMinute();
    expect(fire?.outcome).toBe('published');
    expect(purges).toBeNull();
    expect(calls('claim_release_purges')).toEqual([]);
    expect(calls('record_release_purge').map((c) => c.args['p_status'])).toEqual(['skipped']);
    expect(calls('record_release_purge')[0]!.args).toMatchObject({ p_tenant: T, p_release: REL });
    expect(state.logs.find((l) => l['message'] === 'a scheduled release went live')).toMatchObject({
      level: 'info',
      source: 'cron:releases',
      detail: { releaseId: REL, number: 4, items: 1, purge: 'skipped' },
    });
    // No audit row: the cron is no person (the apply wrote release.publish naming the scheduler).
    expect(calls('audit_log')).toEqual([]);
  });

  it('a section’s page slug is read as the system, scoped to the release’s tenant', async () => {
    state.answers['claim_scheduled_releases'] = ok([due()]);
    state.answers['apply_release'] = live([
      item('page_section', { before: { page_id: PAGE }, after: { page_id: PAGE } }),
    ]);
    await fireDueRelease();
    expect(state.reads).toEqual(['pages']);
  });

  it('a release a second run already published, or one moved later, is left alone (skipped)', async () => {
    state.answers['claim_scheduled_releases'] = ok([due()]);
    state.answers['apply_release'] = ok({
      mode: 'fire',
      release_id: REL,
      skipped: true,
      status: 'published',
    });
    const { fire, purges } = await runReleaseMinute();
    expect(fire).toEqual({ outcome: 'skipped', releaseId: REL });
    expect(calls('record_release_purge')).toEqual([]);
    expect(calls('fail_scheduled_release')).toEqual([]);
    expect(purges).not.toBeNull();
  });
});

describe('a fire fails closed', () => {
  it('the scheduler no longer live, or their role no longer publishing a change: failed before any apply', async () => {
    for (const [over, code] of [
      [{ scheduler: { role: 'admin', tenant_id: T, live: false } }, 'scheduler'],
      [{ scheduler: null }, 'scheduler'],
      [{ items: [{ entity_type: 'service', op: 'update', status: 'archived' }] }, 'forbidden'],
    ] as const) {
      state.calls = [];
      state.logs = [];
      state.answers['claim_scheduled_releases'] = ok([due(over)]);
      const { fire, purges } = await runReleaseMinute();
      expect(fire, code).toEqual({ outcome: 'failed', releaseId: REL, failure: code });
      expect(calls('apply_release')).toEqual([]);
      expect(calls('fail_scheduled_release').map((c) => c.args)).toEqual([
        { p_tenant: T, p_release: REL, p_code: code, p_draft_ids: null },
      ]);
      expect(state.logs).toEqual([
        expect.objectContaining({
          level: 'error',
          source: 'cron:releases',
          detail: { releaseId: REL, failure: code },
        }),
      ]);
      // The purge retries still run that minute.
      expect(purges).not.toBeNull();
    }
  });

  it('the database’s refusals become the release’s failure code, with the drafts it named', async () => {
    const cases: [Record<string, unknown>, string, string[] | null][] = [
      [{ code: 'BR403', message: 'x', details: '{"code":"actor"}' }, 'scheduler', null],
      [{ code: '55000', message: 'x' }, 'releases-off', null],
      [
        {
          code: 'BR409',
          message: 'x',
          details: JSON.stringify({
            code: 'conflict',
            items: [{ draftId: DRAFT, columns: ['title'] }],
          }),
        },
        'conflict',
        [DRAFT],
      ],
      [
        {
          code: 'BR409',
          message: 'x',
          details: JSON.stringify({ code: 'pending-changed', draftIds: [DRAFT] }),
        },
        'changed',
        [DRAFT],
      ],
      [
        {
          code: 'BR422',
          message: 'x',
          details: JSON.stringify({
            code: 'refused',
            items: [
              { draftId: DRAFT, sqlstate: '42501', constraint: null, column: null, message: 'm' },
            ],
          }),
        },
        'refused',
        [DRAFT],
      ],
      [{ code: '22023', message: 'x' }, 'error', null],
    ];
    for (const [error, code, drafts] of cases) {
      state.calls = [];
      state.answers['claim_scheduled_releases'] = ok([due()]);
      state.answers['apply_release'] = () => ({ data: null, error });
      const run = await fireDueRelease();
      expect(run.failure, String(error['code'])).toBe(code);
      expect(calls('fail_scheduled_release')[0]!.args['p_draft_ids'], code).toEqual(drafts);
    }
  });

  it('a busy database leaves it scheduled (tried again after the lease): no failure, a warning, the purges run', async () => {
    state.answers['claim_scheduled_releases'] = ok([due()]);
    state.answers['apply_release'] = () => ({
      data: null,
      error: { code: '55P03', message: 'lock' },
    });
    const { fire, purges } = await runReleaseMinute();
    expect(fire).toEqual({ outcome: 'busy', releaseId: REL });
    expect(calls('fail_scheduled_release')).toEqual([]);
    expect(state.logs).toEqual([
      expect.objectContaining({ level: 'warn', source: 'cron:releases' }),
    ]);
    expect(purges).not.toBeNull();
  });

  it('a claimed release whose changes no longer read fails closed (never claimed again and again)', async () => {
    state.answers['claim_scheduled_releases'] = ok([
      due({ items: [{ entity_type: 'gaming_teaser', op: 'update', status: null }] }),
    ]);
    const run = await fireDueRelease();
    expect(run).toEqual({ outcome: 'failed', releaseId: REL, failure: 'error' });
    expect(calls('apply_release')).toEqual([]);
    expect(calls('fail_scheduled_release')[0]!.args).toMatchObject({ p_code: 'error' });
  });

  it('a failure the release could not be told is logged so, and tried again', async () => {
    state.answers['claim_scheduled_releases'] = ok([due({ scheduler: null })]);
    state.answers['fail_scheduled_release'] = () => ({
      data: null,
      error: { code: 'XX000', message: 'down' },
    });
    await fireDueRelease();
    expect(String(state.logs[0]!['message'])).toContain('nor be marked failed');
  });

  it('a claim that fails is one error line under cron:releases, and the purge retries still run', async () => {
    state.answers['claim_scheduled_releases'] = () => ({
      data: null,
      error: { code: '42501', message: 'no' },
    });
    await runJobs(RELEASE_JOBS);
    expect(state.logs).toEqual([
      expect.objectContaining({ level: 'error', source: 'cron:releases' }),
    ]);
    expect(calls('claim_release_purges')).toHaveLength(1);
    state.calls = [];
    state.logs = [];
    state.answers['claim_scheduled_releases'] = ok([{ release_id: 'x' }]);
    await runJobs(RELEASE_JOBS);
    expect(String(state.logs[0]!['message'])).toContain('wrong shape');
  });
});

describe('the Free plan’s 50 subrequests (each awaited call one, a log line two)', () => {
  const used = () =>
    state.calls.length +
    fetched.length +
    state.snapshotRequests +
    state.reads.length +
    2 * state.logs.length;

  it('a fire that went live, at its worst: every snapshot and record failing, a zone, a retry, four slug reads', async () => {
    state.answers['claim_scheduled_releases'] = ok([
      due({ scheduler: { role: 'admin', tenant_id: T, live: true } }),
    ]);
    state.answers['apply_release'] = live([
      item('redirect', { before: { source_path: '/a' }, after: { source_path: '/b' } }),
      item('page', {
        entity_id: '0e0e0e0e-0000-4000-8000-0000000000c8',
        op: 'delete',
        before: { slug: 'gone' },
        after: null,
      }),
      item('page_section', {
        entity_id: '0e0e0e0e-0000-4000-8000-0000000000c2',
        before: { page_id: PAGE },
        after: { page_id: PAGE },
      }),
      item('entity_seo', {
        entity_id: '0e0e0e0e-0000-4000-8000-0000000000c3',
        before: null,
        after: { entity_type: 'service', entity_id: '0e0e0e0e-0000-4000-8000-0000000000c4' },
      }),
      item('entity_seo', {
        entity_id: '0e0e0e0e-0000-4000-8000-0000000000c5',
        before: null,
        after: { entity_type: 'blog_post', entity_id: '0e0e0e0e-0000-4000-8000-0000000000c6' },
      }),
      item('portfolio_children', {
        entity_id: '0e0e0e0e-0000-4000-8000-0000000000c7',
        before: {},
        after: {},
      }),
    ]);
    state.snapshotsFail = true;
    state.answers['record_release_purge'] = () => ({
      data: null,
      error: { code: 'XX000', message: 'down' },
    });
    await runReleaseMinute(
      zone(new Response('', { status: 503 }), new Response(JSON.stringify({ success: true }))),
    );
    expect(state.reads.sort()).toEqual(['blog_posts', 'pages', 'portfolio', 'services']);
    expect(fetched).toHaveLength(2);
    expect(used()).toBeLessThanOrEqual(RELEASE_FIRE_PUBLISHED_BUDGET);
  });

  it('a fire that did not go live, then the purge retries, within the minute’s budget', async () => {
    state.answers['claim_scheduled_releases'] = ok([due()]);
    state.answers['apply_release'] = () => ({ data: null, error: { code: '22023', message: 'x' } });
    state.answers['fail_scheduled_release'] = () => ({
      data: null,
      error: { code: 'XX000', message: 'down' },
    });
    await fireDueRelease();
    expect(used()).toBeLessThanOrEqual(RELEASE_FIRE_FAILED_BUDGET);
  });

  it('the job declares the worst of the minute’s paths, within 50', () => {
    expect(RELEASE_JOBS).toHaveLength(1);
    expect(RELEASE_JOBS[0]!.name).toBe('releases');
    expect(RELEASE_JOBS[0]!.budget).toBe(RELEASE_MINUTE_BUDGET);
    expect(RELEASE_MINUTE_BUDGET).toBe(
      Math.max(
        RELEASE_FIRE_PUBLISHED_BUDGET,
        RELEASE_FIRE_FAILED_BUDGET + RELEASE_PURGE_BUDGET,
        3 + RELEASE_PURGE_BUDGET,
      ),
    );
    expect(RELEASE_MINUTE_BUDGET).toBeLessThanOrEqual(50);
    expect([
      RELEASE_FIRE_PUBLISHED_BUDGET,
      RELEASE_FIRE_FAILED_BUDGET,
      RELEASE_PURGE_BUDGET,
      RELEASE_MINUTE_BUDGET,
    ]).toEqual([26, 6, 31, 37]);
  });
});
