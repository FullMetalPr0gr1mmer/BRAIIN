import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJob } from '@/lib/cron/jobs';

// The Worker's daily cron, run for real against a stub service client (src/lib/cron/daily.ts
// running the registry in src/lib/cron/jobs.ts): the cheap purges before the lead indexing,
// the privileged-op ledger cut at 48 hours, the media bucket's orphans removed after their
// hour of grace (Admin v2 U3), the lead-notification check's count (H9), a failing step
// logged without stopping the ones after it, the indexing line written even for a partial run, the whole run inside the
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
  worstCaseMedia: false,
  failMediaOrphans: false,
  notifyMisses: 0 as unknown,
  failNotifyCheck: false,
  removed: [] as { bucket: string; keys: string[] }[],
  visibilityRows: [] as Record<string, unknown>[],
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
  for (const m of ['eq', 'neq', 'lt', 'is', 'in', 'order']) {
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
    if (table === 'page_visibility') return { data: state.visibilityRows, error: null };
    if (table === 'job_applications' && req.op === 'select')
      return {
        data: state.worstCaseRetention ? [{ id: 'a1', cv_path: 't/a1/x.pdf' }] : [],
        error: null,
      };
    return { data: [], error: null, count: 0 };
  };
  // Awaited as a list, or followed by maybeSingle() for one row (the launch tenant lookup).
  b['limit'] = () => ({
    then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
      Promise.resolve()
        .then(() => answer())
        .then(ok, fail),
    maybeSingle: b['maybeSingle'],
  });
  b['maybeSingle'] = async () => {
    state.requests.push(req);
    if (table === 'tenants') return { data: { id: 'tenant-1' }, error: null };
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
    if (fn === 'lead_notify_misses') {
      if (state.failNotifyCheck) return { data: null, error: { message: 'function down' } };
      return { data: state.notifyMisses, error: null };
    }
    if (fn === 'media_orphan_objects') {
      if (state.failMediaOrphans) return { data: null, error: { message: 'storage down' } };
      return {
        data: state.worstCaseMedia
          ? Array.from({ length: MEDIA_ORPHAN_BATCH }, (_, i) => ({
              object_name: `t/${String(i).padStart(4, '0')}_10x10.webp`,
            }))
          : [],
        error: null,
      };
    }
    return { data: null, error: null };
  },
  storage: {
    from: (bucket: string) => ({
      remove: async (keys: string[]) => {
        state.requests.push({ table: 'storage', op: 'remove', filters: [] });
        state.removed.push({ bucket, keys });
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
const { MEDIA_ORPHAN_BATCH, MEDIA_ORPHAN_GRACE_MINUTES } = await import('@/lib/media/orphans');
const { EXPORT_LIMITS, MEDIA_UPLOAD_LIMITS, PII_REVEAL_LIMITS } =
  await import('@/lib/admin/rateLimit');
const { encryptPII } = await import('@/lib/crypto/pii');
const { LEAD_PII_ENC_KEY } = await import('astro:env/server');

const { __kv } = await import('../stubs/cloudflare-workers');
const { VISIBILITY_KV_KEY } = await import('@/lib/http/visibility');

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
const notifyLine = () => state.logs.find((l) => l.source === 'cron:lead-notify');

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
  state.worstCaseMedia = false;
  state.failMediaOrphans = false;
  state.notifyMisses = 0;
  state.failNotifyCheck = false;
  state.removed = [];
  state.visibilityRows = [];
  __kv.clear();
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
    for (const limits of [EXPORT_LIMITS, PII_REVEAL_LIMITS, MEDIA_UPLOAD_LIMITS]) {
      expect(PRIVILEGED_OPS_KEEP_MS).toBeGreaterThanOrEqual(limits.windowMinutes * 60_000);
    }
  });

  it("sweeps the media bucket's orphans after the Join retention, before the lead indexing", async () => {
    state.worstCaseMedia = true;
    await runDailyJobs();
    const order = tables();
    expect(order.indexOf('media_orphan_objects:rpc')).toBeGreaterThan(
      order.indexOf('application_orphan_cvs:rpc'),
    );
    expect(order.indexOf('media_orphan_objects:rpc')).toBeLessThan(order.indexOf('leads:select'));
    const media = state.removed.find((r) => r.bucket === 'media');
    expect(media?.keys).toHaveLength(MEDIA_ORPHAN_BATCH);
    expect(state.logs.find((l) => l.source === 'cron:media-orphans')).toMatchObject({
      level: 'info',
      message: 'media orphan sweep ran',
      detail: { found: MEDIA_ORPHAN_BATCH, removed: MEDIA_ORPHAN_BATCH, errors: [] },
    });
    expect(MEDIA_ORPHAN_GRACE_MINUTES).toBeGreaterThanOrEqual(60);
  });

  it('a sweep with nothing to remove calls no Storage API, and still says it ran', async () => {
    await runDailyJobs();
    expect(state.removed.find((r) => r.bucket === 'media')).toBeUndefined();
    expect(state.logs.find((l) => l.source === 'cron:media-orphans')).toMatchObject({
      level: 'info',
      detail: { found: 0, removed: 0 },
    });
  });

  it('a sweep whose lookup fails is logged as an error, and removes nothing', async () => {
    state.failMediaOrphans = true;
    await runDailyJobs();
    expect(state.removed.find((r) => r.bucket === 'media')).toBeUndefined();
    expect(state.logs.find((l) => l.source === 'cron:media-orphans')).toMatchObject({
      level: 'error',
      message: 'media orphan sweep ran with errors (select-orphans)',
    });
    expect(indexLine()).toMatchObject({ level: 'info' });
  });

  it('checks lead notifications after the media sweep, before the lead indexing', async () => {
    await runDailyJobs();
    const order = tables();
    expect(order.indexOf('lead_notify_misses:rpc')).toBeGreaterThan(
      order.indexOf('media_orphan_objects:rpc'),
    );
    expect(order.indexOf('lead_notify_misses:rpc')).toBeLessThan(order.indexOf('leads:select'));
    expect(order.filter((t) => t === 'lead_notify_misses:rpc')).toHaveLength(1);
  });

  it('warns with the count, and only the count, when leads reached no notification', async () => {
    state.notifyMisses = 3;
    await runDailyJobs();
    expect(notifyLine()).toEqual({
      level: 'warn',
      source: 'cron:lead-notify',
      message: '3 lead(s) from the last day reached no notification',
      detail: { configured: true, missed: 3 },
    });
  });

  it('notes a clean check, and says when notifications are not configured', async () => {
    await runDailyJobs();
    expect(notifyLine()).toMatchObject({ level: 'info', detail: { configured: true, missed: 0 } });
    state.logs = [];
    state.notifyMisses = null;
    await runDailyJobs();
    expect(notifyLine()).toMatchObject({ level: 'info', detail: { configured: false } });
    expect(notifyLine()!.message).toContain('lead notifications are off');
  });

  it('a check that fails, or answers nonsense, is logged as an error; the indexing still runs', async () => {
    state.failNotifyCheck = true;
    await runDailyJobs();
    expect(notifyLine()).toMatchObject({ level: 'error', message: 'function down' });
    expect(indexLine()).toMatchObject({ level: 'info' });
    for (const answer of ['3', -1, 1.5, {}]) {
      state.logs = [];
      state.failNotifyCheck = false;
      state.notifyMisses = answer;
      await runDailyJobs();
      expect(notifyLine(), JSON.stringify(answer)).toMatchObject({
        level: 'error',
        message: 'lead notification check: an unexpected answer',
      });
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
    state.worstCaseMedia = true;
    await runDailyJobs();
    expect(tables().filter((t) => t === 'storage:remove')).toHaveLength(3);
    expect(subrequests()).toBeLessThanOrEqual(50);
  });
});

describe('the page-visibility re-sync (Admin v2 U14a)', () => {
  it('rebuilds the launch tenant’s snapshot into KV, after the lead check, before the indexing', async () => {
    state.visibilityRows = [
      {
        mode: 'hidden',
        template: null,
        hide_from: null,
        show_on: null,
        page: { slug: 'about' },
        redirect: { slug: 'contact' },
      },
      {
        mode: 'hidden',
        template: 'service',
        hide_from: null,
        show_on: null,
        page: null,
        redirect: null,
      },
      {
        mode: 'public',
        template: null,
        hide_from: null,
        show_on: null,
        page: { slug: 'join' },
        redirect: null,
      },
    ];
    await runDailyJobs();
    const read = state.requests.find((r) => r.table === 'page_visibility')!;
    expect(read.filters).toEqual([
      'eq:tenant_id=tenant-1',
      'neq:mode=public',
      'order:id=[object Object]',
    ]);
    const order = tables();
    expect(order.indexOf('page_visibility:select')).toBeGreaterThan(
      order.indexOf('lead_notify_misses:rpc'),
    );
    expect(order.indexOf('page_visibility:select')).toBeLessThan(order.indexOf('leads:select'));
    const snapshot = JSON.parse(__kv.get(VISIBILITY_KV_KEY)!);
    expect(snapshot.pages).toEqual({ about: { mode: 'hidden', target: 'contact' } });
    expect(snapshot.templates).toEqual({ service: { mode: 'hidden', target: null } });
    const line = state.logs.find((l) => l.source === 'cron:visibility')!;
    expect(line).toEqual({
      level: 'info',
      source: 'cron:visibility',
      message: 'page visibility re-sync ran',
      detail: { restricted: 2, kvSynced: true },
    });
  });

  it('a failed read is logged under its name, and the jobs after it still run', async () => {
    const original = svc.from;
    svc.from = (table: string) => {
      if (table !== 'page_visibility') return original(table);
      const b = original(table);
      b['limit'] = () => ({
        then: (ok: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: { message: 'relation missing' } }).then(ok),
      });
      return b;
    };
    try {
      await runDailyJobs();
    } finally {
      svc.from = original;
    }
    expect(state.logs.find((l) => l.source === 'cron:visibility')).toMatchObject({
      level: 'error',
      message: 'read page_visibility: relation missing',
    });
    expect(indexLine()).toBeDefined();
    expect(__kv.has(VISIBILITY_KV_KEY)).toBe(false);
  });
});

describe('the job registry (src/lib/cron/jobs.ts)', () => {
  it('runs these jobs, in this order: the purges before the lead indexing', () => {
    expect(DAILY_JOBS.map((job) => job.name)).toEqual([
      'privileged-ops',
      'retention',
      'media-orphans',
      'lead-notify',
      'visibility',
      'crm-index',
    ]);
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
    state.worstCaseMedia = true;
    state.notifyMisses = 7;
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
    // The worst cases were reached: both CV removals, the media removal, and the country
    // lookup.
    expect(seen.filter((t) => t === 'storage:remove')).toHaveLength(3);
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
