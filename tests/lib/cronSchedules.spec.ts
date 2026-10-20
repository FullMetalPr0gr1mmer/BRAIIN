import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Worker's cron schedules (Admin v2 G2, src/lib/cron/schedules.ts): the keys are exactly
// wrangler.jsonc's `triggers.crons`, each schedule's declared budgets fit the Workers Free
// plan's 50 subrequests, the health job runs at its worst within the budget it declares
// (dailyJobs.spec's method: every awaited query, every fetch, two per log line), and a cron
// no schedule names runs nothing and says so.

const state = vi.hoisted(() => ({
  requests: [] as string[],
  logs: [] as { level: string; source?: string; message: string }[],
}));

/** A PostgREST-ish service client: every awaited call is one subrequest. */
function builder(table: string) {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'delete', 'neq', 'lt', 'is', 'in'])
    b[m] = () => b;
  b['maybeSingle'] = async () => {
    state.requests.push(`${table}:maybeSingle`);
    if (table === 'tenants') {
      return {
        data: { id: 'tenant-1', primary_domain: 'braiinstatiion.com', health_probes: [] },
        error: null,
      };
    }
    return { data: null, error: null };
  };
  b['upsert'] = async () => {
    state.requests.push(`${table}:upsert`);
    return { error: null };
  };
  b['then'] = (ok: (v: unknown) => unknown) => {
    state.requests.push(`${table}:select`);
    return Promise.resolve({ data: [], error: null }).then(ok);
  };
  return b;
}
const svc = {
  from: (table: string) => builder(table),
  rpc: async () => ({ data: null, error: null }),
};

vi.mock('@/lib/supabase/server', () => ({ serviceClient: () => svc }));
vi.mock('@/lib/supabase/client', () => ({ supabaseConfigured: () => true }));
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: { level: string; message: string }) => {
    state.logs.push(entry);
    return true;
  },
}));
// The monitor set up, so the worst case reaches it.
vi.mock('astro:env/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  UPTIME_MONITOR_API_KEY: 'test-read-only-key',
}));

const { SCHEDULES, runSchedule } = await import('@/lib/cron/schedules');
const { DAILY_JOBS } = await import('@/lib/cron/jobs');
const { HEALTH_JOBS } = await import('@/lib/cron/health');
const { MAINTENANCE_RECONCILE_JOB } = await import('@/lib/cron/maintenanceReconcile');
const { runJobs } = await import('@/lib/cron/daily');

/** wrangler.jsonc's crons, read from the file as deployed. */
function wranglerCrons(): string[] {
  const text = readFileSync('wrangler.jsonc', 'utf8');
  const list = /"crons"\s*:\s*\[([^\]]*)\]/.exec(text)?.[1];
  if (list === undefined) throw new Error('wrangler.jsonc has no triggers.crons');
  return [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

let fetched: string[] = [];
beforeEach(() => {
  state.requests = [];
  state.logs = [];
  fetched = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const subrequests = () => state.requests.length + fetched.length + 2 * state.logs.length;

describe('the schedules (src/lib/cron/schedules.ts)', () => {
  it('are exactly the cron triggers wrangler.jsonc declares', () => {
    expect(Object.keys(SCHEDULES).sort()).toEqual(wranglerCrons().sort());
    expect(SCHEDULES['23 3 * * *']).toBe(DAILY_JOBS);
    // Every 10 minutes: the health probes, then maintenance's reconcile (Admin v2 U9b joined
    // G2's schedule, the plan's §5.7 default, rather than taking a trigger of its own).
    expect(SCHEDULES['*/10 * * * *']).toEqual([...HEALTH_JOBS, MAINTENANCE_RECONCILE_JOB]);
  });

  it('stay within the Free plan’s 5 cron triggers per account', () => {
    expect(wranglerCrons().length).toBeLessThanOrEqual(5);
  });

  it('each declares budgets that fit the Free plan’s 50 subrequests', () => {
    for (const [cron, jobs] of Object.entries(SCHEDULES)) {
      expect(
        jobs.reduce((sum, job) => sum + job.budget, 0),
        cron,
      ).toBeLessThanOrEqual(50);
    }
  });

  it('job names are unique across schedules (a log line names one job)', () => {
    const names = Object.values(SCHEDULES).flatMap((jobs) => jobs.map((job) => job.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it('dispatches by cron string: the 10-minute schedule runs its two jobs, in order', async () => {
    const ran: string[] = [];
    const jobs = SCHEDULES['*/10 * * * *']! as unknown as { name: string; run: () => Promise<void> }[];
    const originals = jobs.map((job) => job.run);
    for (const job of jobs) {
      job.run = async () => {
        ran.push(job.name);
      };
    }
    try {
      await runSchedule('*/10 * * * *');
    } finally {
      jobs.forEach((job, i) => (job.run = originals[i]!));
    }
    expect(ran).toEqual(['health-probes', 'maintenance-reconcile']);
    expect(state.requests).toEqual([]);
  });

  it('a cron no schedule names runs nothing and leaves one warning', async () => {
    await runSchedule('0 * * * *');
    expect(state.requests).toEqual([]);
    expect(state.logs).toEqual([
      expect.objectContaining({
        level: 'warn',
        source: 'cron',
        message: 'a cron trigger fired that no schedule names; nothing ran',
      }),
    ]);
    state.logs = [];
    await runSchedule('__proto__');
    expect(state.logs).toHaveLength(1);
  });
});

describe('the health job (src/lib/cron/health.ts)', () => {
  it('declares 11: tenant, rows, the monitor, the bootstrap, the registry, the write, a line', () => {
    expect(HEALTH_JOBS.map((job) => [job.name, job.budget])).toEqual([['health-probes', 11]]);
  });

  it('stays within its budget at its worst: every outbound read retried or redirected', async () => {
    const answers: Record<string, Response[]> = {
      'https://api.uptimerobot.com/v2/getMonitors': [
        new Response('', { status: 503 }),
        new Response('', { status: 503 }),
      ],
      'https://data.iana.org/rdap/dns.json': [
        new Response(null, {
          status: 302,
          headers: { location: 'https://data.iana.org/rdap/dns2.json' },
        }),
      ],
      'https://data.iana.org/rdap/dns2.json': [
        new Response(
          JSON.stringify({ services: [[['com'], ['https://rdap.verisign.com/com/v1/']]] }),
        ),
      ],
      'https://rdap.verisign.com/com/v1/domain/braiinstatiion.com': [
        new Response('', { status: 502 }),
        new Response(
          JSON.stringify({
            events: [{ eventAction: 'expiration', eventDate: '2027-05-01T00:00:00Z' }],
          }),
        ),
      ],
    };
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url);
      const next = answers[url]?.shift();
      if (!next) throw new TypeError(`unexpected fetch ${url}`);
      return next;
    });
    await runJobs(HEALTH_JOBS);
    // The worst case was reached: two monitor requests, two bootstrap, two registry.
    expect(fetched).toHaveLength(6);
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]!.source).toBe('cron:health-probes');
    expect(state.requests).toEqual([
      'tenants:maybeSingle',
      'tenants:maybeSingle',
      'health_probes:upsert',
    ]);
    expect(subrequests()).toBeLessThanOrEqual(HEALTH_JOBS[0]!.budget);
    expect(subrequests()).toBe(11);
  });
});
