import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProbeRow } from '@schemas/healthProbe';
import type { UptimeProvider, UptimeReading } from '@/lib/health/uptime';
import { OutboundError } from '@/lib/http/outbound';

const { logs } = vi.hoisted(() => ({ logs: [] as Record<string, unknown>[] }));
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: Record<string, unknown>) => {
    logs.push(entry);
    return true;
  },
}));

const {
  THRESHOLDS,
  TIMING,
  backoffMs,
  certificateOutcome,
  domainState,
  nextProbe,
  retryAfterMs,
  runHealthProbes,
  uptimeFacts,
  uptimeState,
} = await import('@/lib/health/probes');

// The probe runner (Admin v2 G2, src/lib/health/probes.ts): the pure next-state function over
// every transition (a reading, off, a failed read; the backoff's growth and cap; stale after
// six), the incidents' first-seen carried over, the thresholds, and one run end to end
// against a stub client: due probes only (all with `force`), one read, ONE upsert, failures
// logged only when they matter, never a key, a URL or a body.

const NOW = new Date('2026-10-15T12:00:00Z');
const at = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();

function row(over: Partial<ProbeRow> = {}): ProbeRow {
  return {
    kind: 'uptime',
    state: 'ok',
    facts: { ratio30: 99.98 },
    read_ok: true,
    failures: 0,
    checked_at: at(-10),
    ok_at: at(-10),
    next_at: at(-5),
    state_since: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

function reading(over: Partial<UptimeReading> = {}): UptimeReading {
  return {
    ratio30: 99.98,
    ratio90: 99.91,
    days: [{ day: '2026-10-15', ratio: 100 }],
    incidents: [],
    responseTimes: [],
    monitors: [{ name: 'Home', path: '/', intervalSec: 300, status: 'up' }],
    certificate: null,
    downSince: null,
    ...over,
  };
}

describe('nextProbe', () => {
  it('a reading: the state and facts, read_ok, the failures cleared, next due after its cadence', () => {
    const next = nextProbe(
      'uptime',
      row({ failures: 3, read_ok: false }),
      { kind: 'read', state: 'warn', facts: { ratio30: 99.5 }, everyMs: TIMING.uptimeEveryMs },
      NOW,
    );
    expect(next).toEqual({
      kind: 'uptime',
      state: 'warn',
      facts: { ratio30: 99.5 },
      read_ok: true,
      failures: 0,
      checked_at: NOW.toISOString(),
      ok_at: NOW.toISOString(),
      next_at: at(5),
    });
  });

  it('off: no facts, no backoff, the last good reading kept as a date only', () => {
    expect(nextProbe('uptime', row(), { kind: 'off' }, NOW)).toEqual({
      kind: 'uptime',
      state: 'off',
      facts: {},
      read_ok: false,
      failures: 0,
      checked_at: NOW.toISOString(),
      ok_at: at(-10),
      next_at: null,
    });
  });

  it('a failed read keeps the last facts and state, counts it and tries again on the next run', () => {
    const next = nextProbe(
      'uptime',
      row({ state: 'fail' }),
      { kind: 'failed', reason: 'http 503' },
      NOW,
      () => 0.5,
    );
    expect(next).toMatchObject({
      state: 'fail',
      facts: { ratio30: 99.98 },
      read_ok: false,
      failures: 1,
      ok_at: at(-10),
      next_at: at(5),
    });
  });

  it('a first read that fails, or one after off, has nothing to keep: unknown', () => {
    for (const prev of [null, row({ state: 'off', facts: {} })]) {
      expect(
        nextProbe('domain', prev, { kind: 'failed', reason: 'network' }, NOW, () => 0.5),
      ).toMatchObject({
        state: 'unknown',
        facts: {},
        failures: 1,
      });
    }
  });

  it('turns unknown after six failures in a row (an hour at 10 minutes)', () => {
    expect(THRESHOLDS.staleAfter).toBe(6);
    let prev: ProbeRow = row();
    const states: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const next = nextProbe('uptime', prev, { kind: 'failed', reason: 'timeout' }, NOW, () => 0.5);
      states.push(next.state);
      prev = { ...prev, ...next, state_since: prev.state_since };
    }
    expect(states).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'unknown', 'unknown']);
    expect(prev.failures).toBe(7);
  });

  it('retries on the next run until stale, then backs off from there (retryAfterMs)', () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4, 5].map((n) => retryAfterMs(n, mid))).toEqual(Array(5).fill(TIMING.retryMs));
    // The read that makes it stale starts the backoff at its base.
    expect([6, 7, 8, 9].map((n) => retryAfterMs(n, mid) / 60_000)).toEqual([10, 20, 40, 80]);
    expect(retryAfterMs(500, () => 1)).toBe(Math.round(TIMING.backoffCapMs * 1.2));
    // Due again on the schedule's next run, never skipping one.
    expect(TIMING.retryMs).toBeLessThan(10 * 60_000);
  });

  it('backs off from 10 minutes, doubling, to at most 6 hours, within ±20%', () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffMs(n, mid) / 60_000)).toEqual([
      10, 20, 40, 80, 160, 320, 360, 360,
    ]);
    expect(backoffMs(1, () => 0)).toBe(8 * 60_000);
    expect(backoffMs(1, () => 1)).toBe(12 * 60_000);
    expect(backoffMs(50, () => 1)).toBe(Math.round(TIMING.backoffCapMs * 1.2));
  });
});

describe('the states', () => {
  it('uptime: down or seems down fails, under 99.9% warns, no monitors is information', () => {
    expect(uptimeState(reading())).toBe('ok');
    expect(uptimeState(reading({ ratio30: 99.89 }))).toBe('warn');
    expect(uptimeState(reading({ ratio30: 99.9 }))).toBe('ok');
    for (const status of ['down', 'seems-down'] as const) {
      expect(
        uptimeState(reading({ monitors: [{ name: 'x', path: '/', intervalSec: 60, status }] })),
      ).toBe('fail');
    }
    expect(uptimeState(reading({ monitors: [] }))).toBe('info');
  });

  it('domain: 30 days or fewer fails, no registration fails, the rest is information', () => {
    const facts = (over: Record<string, unknown>) => ({
      apex: 'braiinstatiion.com',
      outcome: 'ok' as const,
      expires: null,
      registrar: null,
      rdap: null,
      ...over,
    });
    const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000 + 1000).toISOString();
    expect(domainState(facts({ expires: days(31) }), NOW)).toBe('ok');
    expect(domainState(facts({ expires: days(30) }), NOW)).toBe('fail');
    expect(domainState(facts({ outcome: 'not-found' }), NOW)).toBe('fail');
    expect(domainState(facts({ outcome: 'invalid' }), NOW)).toBe('fail');
    expect(domainState(facts({ outcome: 'unknown' }), NOW)).toBe('info');
    expect(domainState(facts({ outcome: 'not-applicable' }), NOW)).toBe('info');
  });

  it('certificate: from the monitor, failing at 14 days or fewer; else Cloudflare, information', () => {
    const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000 + 1000).toISOString();
    expect(
      certificateOutcome(reading({ certificate: { expires: days(15), issuer: 'R11' } }), NOW),
    ).toMatchObject({
      state: 'ok',
      facts: { source: 'monitor', expires: days(15), issuer: 'R11' },
    });
    expect(
      certificateOutcome(reading({ certificate: { expires: days(14), issuer: null } }), NOW),
    ).toMatchObject({
      state: 'fail',
    });
    expect(certificateOutcome(reading(), NOW)).toMatchObject({
      state: 'info',
      facts: { source: 'cloudflare', expires: null, issuer: null },
    });
  });

  it('keeps when each incident was first seen, and when the outage began', () => {
    const incident = { id: 'm-1', start: at(-120), durationSec: 600, reason: 'Timeout' };
    const prev = {
      ratio30: null,
      ratio90: null,
      days: [],
      incidents: [{ ...incident, seenAt: at(-100) }],
      responseTimes: [],
      monitors: [],
      downSince: at(-30),
    };
    const fresh = { id: 'm-2', start: at(-20), durationSec: 60, reason: 'Down' };
    const facts = uptimeFacts(
      reading({
        incidents: [fresh, incident],
        monitors: [{ name: 'x', path: '/', intervalSec: 60, status: 'down' }],
      }),
      prev,
      NOW,
    );
    expect(facts.incidents.map((i) => [i.id, i.seenAt])).toEqual([
      ['m-2', NOW.toISOString()],
      ['m-1', at(-100)],
    ]);
    // Down with no start from the provider: the earlier downSince stands.
    expect(facts.downSince).toBe(at(-30));
    expect(uptimeFacts(reading(), prev, NOW).downSince).toBeNull();
  });
});

// ── One run, end to end, against a stub client ──────────────────────────────────────────

interface Db {
  domain: string | null;
  rows: ProbeRow[];
  upserts: { rows: Record<string, unknown>[]; options: unknown }[];
  reads: number;
}

function client(db: Db): SupabaseClient {
  return {
    from(table: string) {
      if (table === 'tenants') {
        const b: Record<string, unknown> = {};
        b['select'] = (cols: string) => {
          expect(cols).toContain('health_probes (');
          return b;
        };
        b['eq'] = () => b;
        b['maybeSingle'] = async () => {
          db.reads += 1;
          return { data: { primary_domain: db.domain, health_probes: db.rows }, error: null };
        };
        return b;
      }
      if (table === 'health_probes') {
        return {
          upsert: async (rows: Record<string, unknown>[], options: unknown) => {
            db.upserts.push({ rows, options });
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
}

const BOOT = {
  services: [[['com'], ['https://rdap.verisign.com/com/v1/']]],
};
const DOMAIN = {
  events: [{ eventAction: 'expiration', eventDate: '2027-05-01T10:00:00Z' }],
  entities: [],
};

describe('runHealthProbes', () => {
  let fetched: string[];
  let db: Db;
  beforeEach(() => {
    logs.length = 0;
    fetched = [];
    db = { domain: 'www.braiinstatiion.com', rows: [], upserts: [], reads: 0 };
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url);
      if (url.startsWith('https://data.iana.org/')) return new Response(JSON.stringify(BOOT));
      if (url.startsWith('https://rdap.verisign.com/')) return new Response(JSON.stringify(DOMAIN));
      throw new TypeError('unexpected fetch');
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const provider = (read: () => Promise<UptimeReading>): UptimeProvider => ({
    name: 'fake',
    read: vi.fn(read),
  });

  it('first run: reads once, every probe, and writes all three in ONE upsert', async () => {
    const p = provider(async () =>
      reading({ certificate: { expires: '2026-12-14T00:00:00.000Z', issuer: 'R11' } }),
    );
    const result = await runHealthProbes(client(db), 't1', {
      now: NOW,
      source: 'cron:health-probes',
      provider: p,
    });
    expect(db.reads).toBe(1);
    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0]!.options).toEqual({ onConflict: 'tenant_id,kind' });
    const written = db.upserts[0]!.rows;
    expect(written.map((r) => [r['kind'], r['state']]).sort()).toEqual([
      ['certificate', 'ok'],
      ['domain', 'ok'],
      ['uptime', 'ok'],
    ]);
    expect(written.every((r) => r['tenant_id'] === 't1')).toBe(true);
    // The trigger owns these.
    expect(written.some((r) => 'state_since' in r || 'updated_at' in r)).toBe(false);
    expect(written.find((r) => r['kind'] === 'domain')!['facts']).toMatchObject({
      apex: 'braiinstatiion.com',
      outcome: 'ok',
      expires: '2027-05-01T10:00:00.000Z',
      rdap: { tld: 'com', base: 'https://rdap.verisign.com/com/v1/' },
    });
    expect(fetched).toEqual([
      'https://data.iana.org/rdap/dns.json',
      'https://rdap.verisign.com/com/v1/domain/braiinstatiion.com',
    ]);
    expect(result.failed).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('runs only what is due: the domain about daily, the bootstrap from its 30-day cache', async () => {
    db.rows = [
      row({ kind: 'uptime', next_at: at(-1) }),
      row({
        kind: 'certificate',
        state: 'info',
        facts: { source: 'cloudflare', expires: null, issuer: null },
      }),
      row({
        kind: 'domain',
        facts: {
          apex: 'braiinstatiion.com',
          outcome: 'ok',
          expires: '2027-05-01T10:00:00.000Z',
          registrar: null,
          rdap: {
            tld: 'com',
            base: 'https://rdap.verisign.com/com/v1/',
            fetchedAt: '2026-10-01T00:00:00.000Z',
          },
        },
        next_at: at(60 * 19),
      }),
    ];
    const p = provider(async () => reading());
    await runHealthProbes(client(db), 't1', {
      now: NOW,
      source: 'cron:health-probes',
      provider: p,
    });
    expect(p.read).toHaveBeenCalledTimes(1);
    expect(fetched).toEqual([]);
    expect(db.upserts[0]!.rows.map((r) => r['kind']).sort()).toEqual(['certificate', 'uptime']);

    // Due again: the cached base is used (one request, no bootstrap).
    db.upserts = [];
    db.rows[2] = { ...db.rows[2]!, next_at: at(-1) };
    await runHealthProbes(client(db), 't1', {
      now: NOW,
      source: 'cron:health-probes',
      provider: p,
    });
    expect(fetched).toEqual(['https://rdap.verisign.com/com/v1/domain/braiinstatiion.com']);
  });

  it('force runs every probe, whatever its backoff (Check now)', async () => {
    db.rows = [
      row({ kind: 'uptime', next_at: at(300) }),
      row({ kind: 'domain', next_at: at(600) }),
    ];
    const p = provider(async () => reading());
    await runHealthProbes(client(db), 't1', {
      now: NOW,
      force: true,
      source: 'admin:health',
      provider: p,
    });
    expect(p.read).toHaveBeenCalledTimes(1);
    expect(fetched).toHaveLength(2);
  });

  it('no key: uptime and certificate are off, written once, and the monitor is never called', async () => {
    db.domain = 'braiin-station.braiin.workers.dev';
    await runHealthProbes(client(db), 't1', {
      now: NOW,
      source: 'cron:health-probes',
      provider: null,
    });
    const written = db.upserts[0]!.rows;
    expect(written.map((r) => [r['kind'], r['state']]).sort()).toEqual([
      ['certificate', 'off'],
      ['domain', 'info'],
      ['uptime', 'off'],
    ]);
    expect(fetched).toEqual([]);
    // Off already, and the domain not due: nothing to write.
    db.upserts = [];
    db.rows = [
      row({ kind: 'uptime', state: 'off' }),
      row({ kind: 'certificate', state: 'off' }),
      row({ kind: 'domain', state: 'info', next_at: at(600) }),
    ];
    await runHealthProbes(client(db), 't1', {
      now: NOW,
      source: 'cron:health-probes',
      provider: null,
    });
    expect(db.upserts).toEqual([]);
  });

  it('a failed read is retried next run, takes the certificate with it, and logs once: reason codes only', async () => {
    const key = 'ro-key-should-never-leak';
    const p = provider(async () => {
      throw new OutboundError('http', 503);
    });
    vi.stubGlobal('fetch', async () => new Response(`{"error":"${key}"}`, { status: 500 }));
    const result = await runHealthProbes(client(db), 't1', {
      now: NOW,
      source: 'cron:health-probes',
      provider: p,
      random: () => 0.5,
    });
    expect(result.failed).toEqual([
      { kind: 'uptime', reason: 'http 503' },
      { kind: 'domain', reason: 'http 500' },
    ]);
    const written = db.upserts[0]!.rows;
    for (const r of written) {
      expect(r).toMatchObject({ read_ok: false, failures: 1, state: 'unknown', next_at: at(5) });
    }
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: 'warn', source: 'cron:health-probes' });
    expect(logs[0]!['message']).toBe(
      'health probes: uptime could not be read (http 503); domain could not be read (http 500)',
    );
    const text = JSON.stringify(logs);
    expect(text).not.toContain(key);
    expect(text).not.toContain('https://');
  });

  it('logs the first failure and the sixth (stale), not each one between (a cron run)', async () => {
    const p = provider(async () => {
      throw new OutboundError('timeout');
    });
    const counts: number[] = [];
    for (let failures = 0; failures < 7; failures += 1) {
      logs.length = 0;
      db.rows = [
        row({ kind: 'uptime', failures, next_at: at(-1) }),
        row({ kind: 'domain', next_at: at(600) }),
      ];
      await runHealthProbes(client(db), 't1', {
        now: NOW,
        source: 'cron:health-probes',
        provider: p,
      });
      counts.push(logs.length);
    }
    expect(counts).toEqual([1, 0, 0, 0, 0, 1, 0]);
    // Check now logs every failure someone asked for.
    logs.length = 0;
    db.rows = [row({ kind: 'uptime', failures: 3 })];
    await runHealthProbes(client(db), 't1', {
      now: NOW,
      force: true,
      source: 'admin:health',
      provider: p,
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]!['source']).toBe('admin:health');
  });

  it('goes stale an hour after the last good reading on the 10-minute schedule, whatever the jitter, then backs off', async () => {
    // The cron fires every 10 minutes; each tick runs what is due and the next tick sees the
    // row it wrote. The last good reading is at minute 0; the monitor never answers again.
    const p = provider(async () => {
      throw new OutboundError('timeout');
    });
    const MIN = 60_000;
    for (const jitter of [0, 0.5, 1]) {
      db.rows = [
        row({ kind: 'uptime', checked_at: at(0), ok_at: at(0), next_at: at(5) }),
        row({ kind: 'domain', next_at: at(100_000) }),
      ];
      const attempts: number[] = [];
      let staleAt: number | null = null;
      for (let minute = 10; minute <= 12 * 60; minute += 10) {
        db.upserts = [];
        await runHealthProbes(client(db), 't1', {
          now: new Date(NOW.getTime() + minute * MIN),
          source: 'cron:health-probes',
          provider: p,
          random: () => jitter,
        });
        const written = db.upserts[0]?.rows.find((r) => r['kind'] === 'uptime');
        if (!written) continue;
        attempts.push(minute);
        db.rows = db.rows.map((r) =>
          r.kind === 'uptime' ? ({ ...r, ...written } as ProbeRow) : r,
        );
        if (written['state'] === 'unknown' && staleAt === null) staleAt = minute;
      }
      // Six failed reads, one each tick: stale exactly an hour after the last good reading,
      // as THRESHOLDS, the guide and the bell say.
      expect(staleAt, `jitter ${jitter}`).toBe(60);
      expect(attempts.slice(0, 6), `jitter ${jitter}`).toEqual([10, 20, 30, 40, 50, 60]);
      // Then the breaker: the gaps grow (10 minutes doubling, at most 6 hours, with jitter),
      // so a provider down for a day is not asked every 10 minutes.
      const gaps = attempts
        .slice(5)
        .map((m, i, all) => (i === 0 ? 0 : m - all[i - 1]!))
        .slice(1);
      expect(gaps[0], `jitter ${jitter}`).toBeGreaterThanOrEqual(10);
      for (let i = 1; i < gaps.length; i += 1) expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1]!);
      expect(attempts.length, `jitter ${jitter}`).toBeLessThanOrEqual(12);
    }
  });

  it('a probe never read that goes stale starts its state then, as the stamps trigger does', async () => {
    // Never read: `unknown` from its first failure. The sixth (stale) moves state_since in
    // the database (0067's trigger); the rows a run hands back (Check now's answer) agree.
    const p = provider(async () => {
      throw new OutboundError('timeout');
    });
    const since = at(-50);
    for (const [failures, moved] of [
      [4, false],
      [5, true],
      [6, false],
    ] as const) {
      db.rows = [
        row({
          kind: 'uptime',
          state: 'unknown',
          facts: {},
          read_ok: false,
          ok_at: null,
          failures,
          state_since: since,
        }),
        row({ kind: 'domain', next_at: at(600) }),
      ];
      const result = await runHealthProbes(client(db), 't1', {
        now: NOW,
        source: 'cron:health-probes',
        provider: p,
      });
      const up = result.rows.find((r) => r.kind === 'uptime')!;
      expect(up.failures).toBe(failures + 1);
      expect(up.state_since, `failure ${failures + 1}`).toBe(moved ? NOW.toISOString() : since);
    }
  });

  it("the stamps trigger's stale count is THRESHOLDS.staleAfter", () => {
    const sql = readFileSync(
      fileURLToPath(new URL('../../supabase/migrations/0067_health_probes.sql', import.meta.url)),
      'utf8',
    );
    const body = sql.split('create or replace function app.tg_health_probe_stamps()')[1]!;
    const m = /old\.failures < (\d+) and new\.failures >= (\d+)/.exec(body.split('end $$;')[0]!);
    expect(m, 'the trigger moves state_since when a probe goes stale').not.toBeNull();
    expect(Number(m![1])).toBe(THRESHOLDS.staleAfter);
    expect(Number(m![2])).toBe(THRESHOLDS.staleAfter);
  });

  it('a read or a write the database refuses throws (the cron logs it under its name)', async () => {
    const refusing = {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'down' } }) }),
        }),
      }),
    } as unknown as SupabaseClient;
    await expect(
      runHealthProbes(refusing, 't1', { now: NOW, source: 'x', provider: null }),
    ).rejects.toThrow('read health_probes: down');
  });
});
