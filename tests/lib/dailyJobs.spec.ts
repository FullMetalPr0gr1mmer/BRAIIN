import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJob } from '@/lib/cron/jobs';

// The Worker's daily cron, run for real against a stub service client (src/lib/cron/daily.ts
// running the registry in src/lib/cron/jobs.ts): the cheap purges before the lead indexing,
// the privileged-op ledger cut at 48 hours, a failing step logged without stopping the ones
// after it, the indexing line written even for a partial run, the whole run inside the
// Workers Free plan's 50 subrequests, and each job inside the budget it declares.

interface Call {
  table: string;
  op: string;
  filters: string[];
}

const state = vi.hoisted(() => ({
  configured: true,
  requests: [] as Call[],
  logs: [] as { level: string; source?: string; message: string; detail?: unknown }[],
  leads: [] as Record<string, unknown>[],
  failPurge: false,
  failLeadSelect: false,
  throwOnIndexWrite: 0,
  worstCaseRetention: false,
}));

/** A PostgREST-ish builder: every awaited query is one subrequest, recorded in order. */
function builder(table: string) {
  const req: Call = { table, op: 'select', filters: [] };
  const b: Record<string, unknown> = {};
  b['select'] = () => b;
  b['delete'] = () => {
    req.op = 'delete';
    return b;
  };
  for (const m of ['eq', 'lt', 'is', 'in', 'order']) {
    b[m] = (column: string, value: unknown) => {
      req.filters.push(`${m}:${column}=${String(value)}`);
      return b;
    };
  }
  const answer = () => {
    state.requests.push(req);
    if (table === 'privileged_ops' && state.failPurge)
      return { data: null, error: { message: 'ledger down' } };
    if (table === 'leads' && state.failLeadSelect)
      return { data: null, error: { message: 'statement timeout' } };
    if (table === 'leads') return { data: state.leads, error: null };
    if (table === 'job_applications' && req.op === 'select')
      return {
        data: state.worstCaseRetention ? [{ id: 'a1', cv_path: 't/a1/x.pdf' }] : [],
        error: null,
      };
    return { data: [], error: null, count: 0 };
  };
  b['limit'] = async () => answer();
  b['maybeSingle'] = async () => {
    state.requests.push(req);
    return { data: table === 'site_profile' ? { address_country: 'SA' } : null, error: null };
  };
  b['then'] = (ok: (v: unknown) => unknown) => Promise.resolve(answer()).then(ok);
  return b;
}

const svc = {
  from: (table: string) => builder(table),
  rpc: async (fn: string) => {
    state.requests.push({ table: fn, op: 'rpc', filters: [] });
    if (fn === 'crm_index_lead') {
      const done = state.requests.filter((r) => r.table === 'crm_index_lead').length;
      if (state.throwOnIndexWrite && done === state.throwOnIndexWrite)
        throw new Error('network lost');
      return { data: true, error: null };
    }
    if (fn === 'application_orphan_cvs')
      return {
        data: state.worstCaseRetention ? [{ object_name: 't/old/y.pdf' }] : [],
        error: null,
      };
    return { data: null, error: null };
  },
  storage: {
    from: () => ({
      remove: async () => {
        state.requests.push({ table: 'storage', op: 'remove', filters: [] });
        return { error: null };
      },
    }),
  },
};

vi.mock('@/lib/supabase/server', () => ({ serviceClient: () => svc }));
vi.mock('@/lib/supabase/client', () => ({ supabaseConfigured: () => state.configured }));
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: { level: string; message: string }) => {
    state.logs.push(entry);
    return true;
  },
}));

const { runDailyJobs } = await import('@/lib/cron/daily');
const { DAILY_JOBS, PRIVILEGED_OPS_KEEP_MS } = await import('@/lib/cron/jobs');
const { INDEX_BATCH } = await import('@/lib/crm/indexBackfill');
const { EXPORT_LIMITS, PII_REVEAL_LIMITS } = await import('@/lib/admin/rateLimit');
const { encryptPII } = await import('@/lib/crypto/pii');
const { LEAD_PII_ENC_KEY } = await import('astro:env/server');

const NOW = new Date('2026-10-07T03:23:00Z');

async function leads(n: number) {
  const email_enc = await encryptPII('sara@acme.sa', LEAD_PII_ENC_KEY);
  return Array.from({ length: n }, (_, i) => ({
    id: `lead-${i}`,
    tenant_id: 'tenant-1',
    email_enc,
    phone_enc: null,
    budget_enc: null,
    timeline_text_enc: null,
    timeline_band: null,
    service_of_interest: null,
    company: null,
  }));
}

/** Subrequests of a run: every recorded query, plus two per log line (tenant + insert). */
const subrequests = () => state.requests.length + 2 * state.logs.length;
const tables = () => state.requests.map((r) => `${r.table}:${r.op}`);
const indexLine = () => state.logs.find((l) => l.source === 'cron:crm-index');

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  state.configured = true;
  state.requests = [];
  state.logs = [];
  state.leads = await leads(INDEX_BATCH);
  state.failPurge = false;
  state.failLeadSelect = false;
  state.throwOnIndexWrite = 0;
  state.worstCaseRetention = false;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('runDailyJobs', () => {
  it('purges first, then the Join retention, then indexes leads', async () => {
    await runDailyJobs();
    const order = tables();
    expect(order[0]).toBe('privileged_ops:delete');
    expect(order.indexOf('job_applications:select')).toBeGreaterThan(0);
    expect(order.indexOf('leads:select')).toBeGreaterThan(
      order.indexOf('public_write_attempts:delete'),
    );
    expect(order.filter((t) => t === 'crm_index_lead:rpc')).toHaveLength(INDEX_BATCH);
  });

  it('cuts the privileged-op ledger at 48 hours, never inside a limiter window', async () => {
    await runDailyJobs();
    const purge = state.requests.find((r) => r.table === 'privileged_ops')!;
    expect(purge.op).toBe('delete');
    expect(purge.filters).toEqual([
      `lt:created_at=${new Date(NOW.getTime() - 48 * 3_600_000).toISOString()}`,
    ]);
    for (const limits of [EXPORT_LIMITS, PII_REVEAL_LIMITS]) {
      expect(PRIVILEGED_OPS_KEEP_MS).toBeGreaterThanOrEqual(limits.windowMinutes * 60_000);
    }
  });

  it('a failing step is logged, and the steps after it still run', async () => {
    state.failPurge = true;
    await runDailyJobs();
    expect(state.logs.find((l) => l.source === 'cron:privileged-ops')).toMatchObject({
      level: 'error',
      message: 'ledger down',
    });
    expect(tables()).toContain('job_applications:select');
    expect(indexLine()).toMatchObject({ level: 'info', message: 'lead indexing ran' });
  });

  it('writes the indexing line on every run, with nothing to do too', async () => {
    state.leads = [];
    await runDailyJobs();
    expect(indexLine()).toMatchObject({
      level: 'info',
      detail: { scanned: 0, indexed: 0, failed: 0, unreadable: 0 },
    });
  });

  it('a run that dies part-way is logged with what it did', async () => {
    state.throwOnIndexWrite = 3;
    await runDailyJobs();
    expect(indexLine()).toMatchObject({
      level: 'error',
      message: 'lead indexing failed after 2 lead(s): network lost',
      detail: { indexed: 2 },
    });
  });

  it('a read that fails is logged as a failure', async () => {
    state.failLeadSelect = true;
    await runDailyJobs();
    expect(indexLine()).toMatchObject({ level: 'error' });
    expect(indexLine()!.message).toContain('statement timeout');
  });

  it('a key that decrypts nothing is reported once, and nothing is written', async () => {
    const foreign = await encryptPII('sara@acme.sa', 'some-other-key');
    state.leads = state.leads.map((row) => ({ ...row, email_enc: foreign }));
    await runDailyJobs();
    expect(tables()).not.toContain('crm_index_lead:rpc');
    expect(state.logs.filter((l) => l.source === 'cron:crm-index')).toHaveLength(1);
    expect(indexLine()!.message).toContain('the key decrypts none');
  });

  it('stays inside the Free plan: 50 subrequests, with every step at its worst', async () => {
    state.failPurge = true;
    state.worstCaseRetention = true;
    await runDailyJobs();
    expect(tables().filter((t) => t === 'storage:remove')).toHaveLength(2);
    expect(subrequests()).toBeLessThanOrEqual(50);
  });
});

describe('the job registry (src/lib/cron/jobs.ts)', () => {
  it('runs these jobs, in this order: the purges before the lead indexing', () => {
    expect(DAILY_JOBS.map((job) => job.name)).toEqual(['privileged-ops', 'retention', 'crm-index']);
  });

  it('logs each job under its own name, in that order', async () => {
    // At its worst every job writes exactly one line (the purge only when it fails).
    state.failPurge = true;
    await runDailyJobs();
    expect(state.logs.map((l) => l.source)).toEqual(DAILY_JOBS.map((job) => `cron:${job.name}`));
  });

  it('keeps each job inside the budget it declares, at its worst', async () => {
    state.failPurge = true;
    state.worstCaseRetention = true;
    // A phone on the leads adds the country lookup.
    const phone_enc = await encryptPII('0501234567', LEAD_PII_ENC_KEY);
    state.leads = state.leads.map((row) => ({ ...row, phone_enc }));
    const seen: string[] = [];
    for (const job of DAILY_JOBS) {
      state.requests = [];
      state.logs = [];
      await runDailyJobs([job]);
      expect(subrequests(), job.name).toBeLessThanOrEqual(job.budget);
      seen.push(...tables());
    }
    // The worst cases were reached: both CV removals, and the country lookup.
    expect(seen.filter((t) => t === 'storage:remove')).toHaveLength(2);
    expect(seen).toContain('site_profile:select');
  });

  it('declares budgets that fit the Free plan together', () => {
    expect(DAILY_JOBS.reduce((sum, job) => sum + job.budget, 0)).toBeLessThanOrEqual(50);
  });
});

describe('the runner (src/lib/cron/daily.ts)', () => {
  const job = (name: string, run: () => Promise<void>): CronJob => ({
    name,
    label: `the ${name} job`,
    budget: 0,
    run,
  });

  it('logs a job that throws under its name, and still runs the jobs after it', async () => {
    const ran: string[] = [];
    await runDailyJobs([
      job('first', async () => {
        ran.push('first');
        throw new Error('boom');
      }),
      job('second', async () => {
        throw 'not an Error';
      }),
      job('third', async () => {
        ran.push('third');
      }),
    ]);
    expect(ran).toEqual(['first', 'third']);
    expect(state.logs).toEqual([
      { level: 'error', source: 'cron:first', message: 'boom' },
      { level: 'error', source: 'cron:second', message: 'the second job failed' },
    ]);
  });

  it('runs nothing while Supabase is not configured', async () => {
    state.configured = false;
    await runDailyJobs();
    expect(state.requests).toEqual([]);
    expect(state.logs).toEqual([]);
  });
});
