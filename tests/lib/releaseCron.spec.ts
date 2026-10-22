import { beforeEach, describe, expect, it, vi } from 'vitest';

// The minute schedule (Admin v2 R7, src/lib/cron/releases.ts): one claim in the database (the
// due releases of one tenant, leased), what an orphan owes rebuilt as the system, ONE purge
// for every claimed release (more than 30 tags together is tenant:default), each release's
// outcome recorded with its backoff, one line a run, and nothing at all when nothing is due.
// The worst case stays within the subrequests the job declares.

const state = vi.hoisted(() => ({
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  claim: (() => ({ data: [], error: null })) as () => { data: unknown; error: unknown },
  record: (() => ({ data: null, error: null })) as () => { data: unknown; error: unknown },
  take: (() => ({ data: true, error: null })) as () => { data: unknown; error: unknown },
  logs: [] as Record<string, unknown>[],
  syncs: [] as string[],
  // Simulated subrequests of the mocked snapshot rebuilds.
  snapshotRequests: 0,
  snapshotsFail: false,
}));

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.calls.push({ fn, args });
      if (fn === 'claim_release_purges') return state.claim();
      if (fn === 'record_release_purge') return state.record();
      if (fn === 'cache_purge_take') return state.take();
      return { data: null, error: { code: 'XX000', message: `unexpected ${fn}` } };
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
// The snapshot rebuilds, as the system: the redirect rules and their KV write; the visibility
// rows, the write, the rows again and the write again. A failure logs a line, as they do.
vi.mock('@/lib/admin/redirectSync', () => ({
  syncRedirectsOfTenant: async (_sb: unknown, tenantId: string) => {
    state.syncs.push(`redirects:${tenantId}`);
    state.snapshotRequests += 2;
    if (state.snapshotsFail) {
      state.logs.push({ level: 'error', source: 'admin:redirect.sync', message: 'down' });
      return { kvSynced: false, count: 0, truncated: false };
    }
    return { kvSynced: true, count: 3, truncated: false };
  },
}));
vi.mock('@/lib/admin/visibilitySync', () => ({
  rebuildVisibilitySnapshot: async (_sb: unknown, tenantId: string) => {
    state.syncs.push(`visibility:${tenantId}`);
    state.snapshotRequests += 4;
    if (state.snapshotsFail) throw new Error('read page_visibility: down');
    return { snapshot: {}, kvSynced: true };
  },
}));

const { runReleasePurges, cronTags, RELEASE_JOBS, RELEASE_CLAIM_LIMIT } =
  await import('@/lib/cron/releases');
const { purgeRetryAt, RELEASE_PURGE_MAX_ATTEMPTS } = await import('@/lib/release/afterEffects');
const { resetPurgeBreaker, COLLAPSE_TAG } = await import('@/lib/http/purge');
const { runJobs } = await import('@/lib/cron/daily');

const T = '00000000-0000-4000-8000-0000000000b1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';
const rid = (n: number) => `0e0e0e0e-0000-4000-8000-${String(n).padStart(12, '0')}`;
const claimed = (n: number, over: Record<string, unknown> = {}) => ({
  tenant_id: T,
  release_id: rid(n),
  number: n,
  tags: [`service:s${n}`, 'services:all'],
  status: 'failed',
  attempts: 1,
  orphan: false,
  ...over,
});

const fetched: string[] = [];
function zone(...answers: Response[]) {
  return {
    config: { zoneId: '0123456789abcdef0123456789abcdef', token: 'purge-token' },
    fetchImpl: (async (url: string, init: RequestInit) => {
      fetched.push(String(init.body));
      const next = answers.shift();
      if (!next) throw new Error(`unexpected fetch ${url}`);
      return next;
    }) as unknown as typeof fetch,
    sleep: async () => undefined,
    random: () => 0.5,
  };
}
const ok = () => new Response(JSON.stringify({ success: true }));
const records = () => state.calls.filter((c) => c.fn === 'record_release_purge');

beforeEach(() => {
  state.calls = [];
  state.claim = () => ({ data: [], error: null });
  state.record = () => ({ data: null, error: null });
  state.take = () => ({ data: true, error: null });
  state.logs = [];
  state.syncs = [];
  state.snapshotRequests = 0;
  state.snapshotsFail = false;
  fetched.length = 0;
  resetPurgeBreaker();
});

describe('a minute with nothing due (every minute while releases are off)', () => {
  it('is one claim: nothing purged, recorded or logged', async () => {
    const run = await runReleasePurges(zone());
    expect(run).toMatchObject({ claimed: 0, purge: null });
    expect(state.calls).toEqual([
      { fn: 'claim_release_purges', args: { p_limit: RELEASE_CLAIM_LIMIT } },
    ]);
    expect(state.logs).toEqual([]);
    expect(fetched).toEqual([]);
  });
});

describe('failed purges, due again', () => {
  it('are purged together in one request and each recorded done', async () => {
    state.claim = () => ({ data: [claimed(1), claimed(2)], error: null });
    const run = await runReleasePurges(zone(ok()));
    expect(run).toMatchObject({ claimed: 2, orphans: 0, purge: 'done', exhausted: 0 });
    expect(fetched).toHaveLength(1);
    expect(JSON.parse(fetched[0]!)).toEqual({
      tags: ['service:s1', 'services:all', 'service:s2'],
    });
    expect(state.calls.find((c) => c.fn === 'cache_purge_take')?.args).toEqual({
      p_tenant: T,
      p_tags: 3,
      p_source: 'cron',
    });
    expect(records().map((c) => c.args)).toEqual([
      {
        p_tenant: T,
        p_release: rid(1),
        p_status: 'done',
        p_tags: null,
        p_next_at: null,
        p_side_effects: {},
      },
      expect.objectContaining({ p_release: rid(2), p_status: 'done', p_next_at: null }),
    ]);
    expect(state.logs).toEqual([
      expect.objectContaining({ level: 'info', source: 'cron:releases' }),
    ]);
  });

  it('more than 30 tags together are purged as tenant:default', () => {
    const many = Array.from({ length: 5 }, (_, n) =>
      claimed(n, { tags: Array.from({ length: 8 }, (_, k) => `service:r${n}-${k}`) }),
    );
    expect(cronTags(many as never).length).toBe(40);
    expect(cronTags([claimed(1, { orphan: true })] as never)).toEqual([COLLAPSE_TAG]);
    expect(cronTags([claimed(1, { tags: [] })] as never)).toEqual([COLLAPSE_TAG]);
  });

  it('a purge that fails again is recorded failed with its next try, backed off; a warning', async () => {
    state.claim = () => ({ data: [claimed(3, { attempts: 3 })], error: null });
    const before = Date.now();
    const run = await runReleasePurges(zone(new Response('', { status: 429 })));
    expect(run).toMatchObject({ purge: 'failed', reason: 'rate-limited', exhausted: 0 });
    const [record] = records();
    expect(record!.args).toMatchObject({ p_status: 'failed', p_tags: null });
    // The fourth attempt is recorded: the next in 8 minutes, jittered (here 0.75 of it).
    const next = Date.parse(String(record!.args['p_next_at'])) - before;
    expect(next).toBeGreaterThanOrEqual(6 * 60_000 - 1_000);
    expect(next).toBeLessThanOrEqual(6 * 60_000 + 1_000);
    expect(state.logs).toEqual([
      expect.objectContaining({ level: 'warn', source: 'cron:releases' }),
    ]);
  });

  it('the tenth failure is the last: no next try, an error line (and the dashboard’s purge_failed)', async () => {
    state.claim = () => ({
      data: [claimed(4, { attempts: RELEASE_PURGE_MAX_ATTEMPTS - 1 })],
      error: null,
    });
    const run = await runReleasePurges(zone(new Response('', { status: 400 })));
    expect(run.exhausted).toBe(1);
    expect(records()[0]!.args).toMatchObject({ p_status: 'failed', p_next_at: null });
    expect(state.logs).toEqual([
      expect.objectContaining({ level: 'error', source: 'cron:releases' }),
    ]);
  });
});

describe('a release whose after-effects never ran (the Worker stopped after the commit)', () => {
  it('gets both snapshots rebuilt as the system, for its tenant, and the whole site purged', async () => {
    state.claim = () => ({
      data: [claimed(5, { status: 'pending', attempts: 0, tags: [], orphan: true })],
      error: null,
    });
    const run = await runReleasePurges(zone(ok()));
    expect(state.syncs).toEqual([`redirects:${T}`, `visibility:${T}`]);
    expect(run).toMatchObject({ orphans: 1, purge: 'done', kvSynced: true });
    expect(JSON.parse(fetched[0]!)).toEqual({ tags: [COLLAPSE_TAG] });
    expect(records()[0]!.args).toMatchObject({
      p_release: rid(5),
      p_status: 'done',
      p_tags: [COLLAPSE_TAG],
      p_side_effects: { kvSynced: true },
    });
  });

  it('with no cache zone (O-3): the snapshots still, the purge skipped and recorded', async () => {
    state.claim = () => ({
      data: [claimed(6, { status: 'pending', attempts: 0, tags: [], orphan: true })],
      error: null,
    });
    const run = await runReleasePurges({ config: null });
    expect(run).toMatchObject({ purge: 'skipped' });
    expect(state.syncs).toHaveLength(2);
    expect(state.calls.some((c) => c.fn === 'cache_purge_take')).toBe(false);
    expect(records()[0]!.args).toMatchObject({ p_status: 'skipped', p_next_at: null });
  });
});

describe('the claim', () => {
  it('names one tenant; a row of another is left for its own minute', async () => {
    state.claim = () => ({
      data: [claimed(7), { ...claimed(8), tenant_id: OTHER }],
      error: null,
    });
    await runReleasePurges(zone(ok()));
    expect(records().map((c) => c.args['p_release'])).toEqual([rid(7)]);
  });

  it('a failed claim or an answer of the wrong shape throws: the runner logs it under cron:releases', async () => {
    state.claim = () => ({ data: null, error: { code: '42501', message: 'no' } });
    await expect(runReleasePurges()).rejects.toThrow(/claim_release_purges/);
    state.claim = () => ({ data: [{ release_id: 'x' }], error: null });
    await expect(runReleasePurges()).rejects.toThrow(/wrong shape/);
    state.logs = [];
    await runJobs(RELEASE_JOBS);
    expect(state.logs).toEqual([
      expect.objectContaining({ level: 'error', source: 'cron:releases' }),
    ]);
  });

  it('an outcome the release cannot be told is counted and logged, and the run goes on', async () => {
    state.claim = () => ({ data: [claimed(9), claimed(10)], error: null });
    state.record = () => ({ data: null, error: { code: 'P0002', message: 'gone' } });
    const run = await runReleasePurges(zone(ok()));
    expect(run.unrecorded).toBe(2);
    expect(records()).toHaveLength(2);
    expect(state.logs.filter((l) => l['source'] === 'release:purge')).toHaveLength(2);
  });
});

describe('the backoff', () => {
  it('1, 2, 4… minutes, at most 60, each jittered to between half and all of it; none past 10', () => {
    const at = (attempts: number, random: number) =>
      (Date.parse(purgeRetryAt(attempts, 0, () => random)!) - 0) / 60_000;
    expect(at(1, 1)).toBe(1);
    expect(at(1, 0)).toBe(0.5);
    expect(at(3, 1)).toBe(4);
    expect(at(8, 1)).toBe(60);
    expect(at(9, 0)).toBe(30);
    expect(purgeRetryAt(RELEASE_PURGE_MAX_ATTEMPTS)).toBeNull();
  });
});

describe('the Free plan’s 50 subrequests', () => {
  it('the worst run stays within the budget the job declares', async () => {
    // Every claimed release an orphan or a failure, every snapshot step and every record
    // failing (each a log line), the purge set up and retried once.
    state.claim = () => ({
      data: Array.from({ length: RELEASE_CLAIM_LIMIT }, (_, n) =>
        claimed(20 + n, n === 0 ? { orphan: true, status: 'pending', attempts: 0 } : {}),
      ),
      error: null,
    });
    state.snapshotsFail = true;
    state.record = () => ({ data: null, error: { code: 'XX000', message: 'down' } });
    await runReleasePurges(zone(new Response('', { status: 503 }), ok()));
    const used =
      state.calls.length + fetched.length + state.snapshotRequests + 2 * state.logs.length;
    expect(fetched).toHaveLength(2);
    expect(used).toBeLessThanOrEqual(RELEASE_JOBS[0]!.budget);
    expect(RELEASE_JOBS[0]!.budget).toBeLessThanOrEqual(50);
  });
});
