import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { AuthorizationError } from '@/lib/authz/errors';
import { RateLimitError } from '@/lib/admin/errors';

// The activity log's CSV export (Admin v2 U13, GET /api/admin/audit/export) under the export
// lockdown (CLAUDE.md §3, §7), in order: both capabilities, the live recheck, the rate limit
// on its own op, the attempt row (fatal: 503, or back to the page for a person who clicked),
// the read through the caller's own client, the outcome row, the abnormal-volume warning.
// The file: field names only, never a detail's values, never the hashes, no titles; a
// spreadsheet formula in a name is neutralised; a file cut at its cap says so.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';
const AMAL = '22222222-2222-4222-8222-222222222222';
const BASHIR = '33333333-3333-4333-8333-333333333333';

const order: string[] = [];
const audits: { action: string; detail?: Record<string, unknown> }[] = [];
const systemLogs: { level: string; message: string }[] = [];
const reads: { table: string; calls: [string, unknown[]][] }[] = [];
const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
let pages: Record<string, unknown>[][] = [];
let attemptFails = false;
let limited = false;
let ledgerDown = false;
let demoted = false;
let names: Record<string, unknown>[] = [];

vi.mock('@/lib/admin/liveRecheck', () => ({
  liveRecheck: async () => {
    order.push('live');
    if (demoted) throw new AuthorizationError('live-recheck', 'role changed');
  },
}));
vi.mock('@/lib/admin/rateLimit', () => ({
  claimPrivilegedOp: async (_auth: unknown, op: string) => {
    order.push(`limit:${op}`);
    if (limited) throw new RateLimitError(`${op}:user`);
    if (ledgerDown) throw new RateLimitError(`${op}:unavailable`);
  },
}));
vi.mock('@/lib/admin/audit', () => ({
  writeAudit: async (_sb: unknown, _auth: unknown, entry: (typeof audits)[number]) => {
    order.push(entry.action);
    audits.push(entry);
    return !(attemptFails && entry.action === 'export.activity.attempt');
  },
}));
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: (typeof systemLogs)[number]) => {
    systemLogs.push(entry);
    return true;
  },
}));
vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => {
    throw new Error('the activity export never reads as the service role');
  },
}));

const { GET } = await import('@/pages/api/admin/audit/export');
const { ACTIVITY_EXPORT_CAP, ACTIVITY_CSV_HEADER } = await import('@/lib/admin/activityExport');

function db() {
  return {
    from(table: string) {
      const read = { table, calls: [] as [string, unknown[]][] };
      reads.push(read);
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'gte', 'lt', 'or', 'in', 'order', 'limit', 'range']) {
        b[m] = (...args: unknown[]) => {
          read.calls.push([m, args]);
          return b;
        };
      }
      b['then'] = (ok: (v: unknown) => unknown) => {
        order.push(`read:${table}`);
        return Promise.resolve({ data: pages.shift() ?? [], error: null }).then(ok);
      };
      return b;
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcs.push({ fn, args });
      return { data: fn === 'audit_people' ? names : null, error: null };
    },
  };
}

function call(
  query = '',
  {
    role = 'developer',
    navigate = false,
    headers = {} as Record<string, string>,
  }: { role?: string; navigate?: boolean; headers?: Record<string, string> } = {},
) {
  const url = new URL(`https://admin.example.test/api/admin/audit/export${query}`);
  return (GET as APIRoute)({
    request: new Request(url, {
      headers: { ...(navigate ? { 'sec-fetch-mode': 'navigate' } : {}), ...headers },
    }),
    url,
    params: {},
    locals: {
      session: { userId: USER, tenantId: TENANT, role, isActive: true, email: 'x@example.test' },
      supabase: db(),
      cspNonce: 'n',
      csrfToken: 'c',
    },
  } as unknown as Parameters<APIRoute>[0]) as Promise<Response>;
}

const ROW = {
  id: 500,
  actor_id: AMAL,
  actor_role: 'admin',
  action: 'lead.update',
  entity_type: 'lead',
  entity_id: '44444444-4444-4444-8444-444444444444',
  // As the export reads it: the few detail keys it names, one by one (EXPORT_COLUMNS). A
  // `detail` the fake also returns stands for what a careless select would have read.
  d_fields: ['stage_id', 'tags'],
  d_status: null,
  detail: { email: 'sara@acme.example', note: 'Called twice' },
  created_at: '2026-10-15T09:30:00.000Z',
  prev_hash: 'should-never-be-read',
  hash: 'should-never-be-read',
};

/** `n` entries, newest first, ids counting down from `top`. */
function rows(n: number, top = 5000): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({ ...ROW, id: top - i }));
}

/** One CSV line's cells (toCsv quotes every cell). */
function cells(line: string): string[] {
  return [...line.replace(/^﻿/, '').matchAll(/"((?:[^"]|"")*)"/g)].map((m) =>
    (m[1] ?? '').replace(/""/g, '"'),
  );
}

beforeEach(() => {
  order.length = 0;
  audits.length = 0;
  systemLogs.length = 0;
  reads.length = 0;
  rpcs.length = 0;
  pages = [[ROW]];
  attemptFails = false;
  limited = false;
  ledgerDown = false;
  demoted = false;
  names = [
    { id: AMAL, display_name: 'Amal', role: 'admin', is_active: true },
    {
      id: BASHIR,
      display_name: '=HYPERLINK("https://evil.example","x")',
      role: 'seo',
      is_active: false,
    },
  ];
});

describe('the lockdown, in order', () => {
  it('cap, live recheck, its own rate-limit op, the attempt, the read, the outcome', async () => {
    const res = await call('?kind=leads&from=2026-10-01');
    expect(res.status).toBe(200);
    expect(order).toEqual([
      'live',
      'limit:export-activity',
      'export.activity.attempt',
      // Keyset pages until one comes back empty (a short page may be the server's row limit).
      'read:audit_log',
      'read:audit_log',
      'export.activity.outcome',
    ]);
    expect(audits[0]).toEqual({
      action: 'export.activity.attempt',
      entityType: 'audit_log',
      detail: { filters: ['kind', 'from'] },
    });
    expect(audits[1]?.detail).toEqual({
      status: 'ok',
      rows: 1,
      truncated: false,
      cap: ACTIVITY_EXPORT_CAP,
    });
  });

  it('refuses a role that may not read the log, before anything else', async () => {
    for (const role of ['content_creator', 'seo']) {
      order.length = 0;
      const res = await call('', { role });
      expect(res.status, role).toBe(403);
      expect(order, role).toEqual([]);
    }
  });

  it('another site cannot make a person export: 403 before a slot or a row is spent', async () => {
    for (const headers of [
      { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
      { origin: 'https://evil.example' },
      { referer: 'https://evil.example/trap' },
    ]) {
      order.length = 0;
      audits.length = 0;
      const res = await call('?kind=leads', { headers });
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(await res.json()).toMatchObject({ ok: false, error: 'forbidden' });
      expect(order, JSON.stringify(headers)).toEqual([]);
      expect(audits).toEqual([]);
    }
    const ours = await call('', { headers: { 'sec-fetch-site': 'same-origin' } });
    expect(ours.status).toBe(200);
  });

  it('a demoted Developer (the live recheck) is refused: no attempt row, nothing read (§9 b)', async () => {
    demoted = true;
    const res = await call();
    expect(res.status).toBe(403);
    expect(order).toEqual(['live']);
  });

  it('the fourth export in an hour: 429, or back to the page with a notice for a person', async () => {
    limited = true;
    const api = await call('?kind=leads');
    expect(api.status).toBe(429);
    const person = await call('?kind=leads&actor=' + AMAL, { navigate: true });
    expect(person.status).toBe(303);
    expect(person.headers.get('location')).toBe(
      `/admin/audit?kind=leads&actor=${AMAL}&export=limit`,
    );
    expect(person.headers.get('cache-control')).toContain('no-store');
    expect(order.filter((o) => o.startsWith('read') || o.startsWith('export'))).toEqual([]);
  });

  it('a limiter that cannot be read is not the hourly limit: the page says it could not run', async () => {
    ledgerDown = true;
    const api = await call('?kind=leads');
    expect(api.status).toBe(429);
    const person = await call('?kind=leads', { navigate: true });
    expect(person.status).toBe(303);
    expect(person.headers.get('location')).toBe('/admin/audit?kind=leads&export=unavailable');
    expect(order.filter((o) => o.startsWith('read') || o.startsWith('export'))).toEqual([]);
  });

  it('an attempt that cannot be written stops the export: 503, nothing read', async () => {
    attemptFails = true;
    const res = await call();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'audit-unavailable' });
    expect(order).not.toContain('read:audit_log');
    const person = await call('', { navigate: true });
    expect(person.status).toBe(303);
    expect(person.headers.get('location')).toBe('/admin/audit?export=unavailable');
  });

  it('reads through the caller’s own client, scoped to its tenant, with the filters', async () => {
    await call(`?kind=users&actor=${AMAL}&from=2026-10-01&to=2026-10-15`);
    const read = reads.find((r) => r.table === 'audit_log')!;
    expect(read.calls).toEqual(
      expect.arrayContaining([
        ['eq', ['tenant_id', TENANT]],
        ['eq', ['actor_id', AMAL]],
        ['gte', ['created_at', '2026-09-30T21:00:00.000Z']],
        ['lt', ['created_at', '2026-10-15T21:00:00.000Z']],
        ['order', ['id', { ascending: false }]],
      ]),
    );
    expect(String(read.calls.find(([m]) => m === 'select')?.[1][0])).not.toMatch(/hash/);
    expect(rpcs).toEqual([{ fn: 'audit_people', args: { p_tenant: TENANT, p_ids: [AMAL] } }]);
  });
});

describe('the file', () => {
  it('reads only the detail keys its words need, never the whole detail', async () => {
    await call();
    const select = String(
      reads.find((r) => r.table === 'audit_log')?.calls.find(([m]) => m === 'select')?.[1][0],
    );
    expect(select.split(',')).not.toContain('detail');
    expect(select).toContain('d_status:detail->>status');
    expect(select).toContain('d_fields:detail->fields');
    expect(select).not.toMatch(/hash/);
  });

  it('a save that published reads as a publish from the keys it read', async () => {
    pages = [
      [
        {
          ...ROW,
          action: 'service.update',
          entity_type: 'service',
          d_fields: ['status'],
          d_status: 'published',
          d_previous: 'draft',
        },
      ],
    ];
    const [, line] = (await (await call()).text()).split('\r\n');
    expect(cells(line!).slice(4, 6)).toEqual(['Publish', 'Published the service']);
  });

  it('is a no-store attachment with the stated columns', async () => {
    const res = await call();
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="activity-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0, must-revalidate');
    expect(res.headers.get('x-export-truncated')).toBe('false');
    const [header, line] = (await res.text()).split('\r\n');
    expect(cells(header!)).toEqual([...ACTIVITY_CSV_HEADER]);
    expect(cells(line!)).toEqual([
      '2026-10-15T09:30:00.000Z',
      '15 Oct 2026, 12:30',
      'Amal',
      'Admin',
      'Lead',
      'Updated a lead',
      'lead',
      '44444444-4444-4444-8444-444444444444',
      'Stage, Tags',
    ]);
  });

  it('never holds a detail’s values, the hashes or a title', async () => {
    pages = [
      [
        {
          ...ROW,
          action: 'service.update',
          entity_type: 'service',
          d_fields: ['title'],
          detail: { email: 'sara@acme.example', items: ['a'.repeat(100)] },
        },
      ],
    ];
    const text = await (await call()).text();
    expect(text).not.toContain('sara@acme.example');
    expect(text).not.toContain('should-never-be-read');
    expect(text).not.toContain('Called twice');
    // No title is looked up (no entity table is read); site_settings is the studio's time
    // zone, the file's `when_studio` column (Admin v2 U9).
    expect(new Set(reads.map((r) => r.table))).toEqual(new Set(['audit_log', 'site_settings']));
  });

  it('neutralises a spreadsheet formula in a name, and marks a former member', async () => {
    pages = [[{ ...ROW, actor_id: BASHIR, actor_role: 'seo' }]];
    const [, line] = (await (await call()).text()).split('\r\n');
    expect(cells(line!)[2]).toBe(`'=HYPERLINK("https://evil.example","x") (former member)`);
  });

  it('stops at its cap and says so: header, file name, outcome row and a warning line', async () => {
    pages = [rows(ACTIVITY_EXPORT_CAP), rows(1, 5000 - ACTIVITY_EXPORT_CAP)];
    const res = await call();
    const lines = (await res.text()).trim().split('\r\n');
    expect(lines).toHaveLength(ACTIVITY_EXPORT_CAP + 1);
    expect(res.headers.get('x-export-truncated')).toBe('true');
    expect(res.headers.get('content-disposition')).toMatch(
      new RegExp(`filename="activity-\\d{4}-\\d{2}-\\d{2}-first-${ACTIVITY_EXPORT_CAP}\\.csv"`),
    );
    expect(audits.at(-1)?.detail).toMatchObject({
      status: 'ok',
      rows: ACTIVITY_EXPORT_CAP,
      truncated: true,
    });
    expect(systemLogs.map((l) => l.level)).toEqual(['warn']);
    // A page of the server's 1,000 rows, then the one row past the cap that says more remain.
    const limits = reads.flatMap((r) =>
      r.calls.filter(([m]) => m === 'limit').map(([, a]) => a[0]),
    );
    expect(limits).toEqual([1000, ACTIVITY_EXPORT_CAP + 1 - 1000]);
  });

  it('pages on the id when a server answers fewer rows than asked', async () => {
    pages = [rows(400, 5000), rows(400, 4600), []];
    const res = await call();
    expect(res.headers.get('x-export-rows')).toBe('800');
    const audit = reads.filter((r) => r.table === 'audit_log');
    expect(audit).toHaveLength(3);
    expect(audit[1]?.calls).toEqual(expect.arrayContaining([['lt', ['id', 4601]]]));
    expect(audit[2]?.calls).toEqual(expect.arrayContaining([['lt', ['id', 4201]]]));
  });

  it('a read that fails writes a failed outcome', async () => {
    // A page whose last id cannot key the next one.
    pages = [[{ ...ROW, id: 'not-a-number' }]];
    const res = await call();
    expect(res.status).toBe(500);
    expect(audits.at(-1)).toMatchObject({
      action: 'export.activity.outcome',
      detail: { status: 'failed', rows: 0 },
    });
  });
});

describe('the studio clock, without Intl', () => {
  it('prints what relTime’s formatDateTime prints, across days, months and years', async () => {
    const { studioDateTimeWriter } = await import('@/lib/admin/activityExport');
    const { clockFor } = await import('@/lib/admin/relTime');
    const riyadhDateTime = studioDateTimeWriter('Asia/Riyadh');
    const { formatDateTime } = clockFor('Asia/Riyadh');
    const start = Date.UTC(2025, 11, 31, 18, 0);
    for (let i = 0; i < 400; i += 1) {
      // Steps of 7 h 13 min: every hour of the day, both sides of midnight and of a new year.
      const at = new Date(start + i * (7 * 60 + 13) * 60_000).toISOString();
      expect(riyadhDateTime(at), at).toBe(formatDateTime(at));
    }
    expect(riyadhDateTime('2026-12-31T21:30:00.000+00:00')).toBe('1 Jan 2027, 00:30');
    expect(riyadhDateTime('not a time')).toBe('');
  });

  it('follows the studio’s zone, daylight saving included (Admin v2 U9)', async () => {
    const { studioDateTimeWriter } = await import('@/lib/admin/activityExport');
    const { clockFor } = await import('@/lib/admin/relTime');
    const { STUDIO_TIME_ZONES } = await import('@schemas/timeZones');
    const sweep = (tz: string, start: number, steps: number, stepMin: number) => {
      const write = studioDateTimeWriter(tz);
      const { formatDateTime } = clockFor(tz);
      for (let i = 0; i < steps; i += 1) {
        const at = new Date(start + i * stepMin * 60_000).toISOString();
        expect(write(at), `${tz} ${at}`).toBe(formatDateTime(at));
      }
    };
    // Every zone across the year, in 1 d 7 h 13 min steps (every hour of the day comes up).
    for (const { value: tz } of STUDIO_TIME_ZONES) sweep(tz, Date.UTC(2026, 0, 1, 0, 7), 300, 1873);
    // Around each 2026 change, minute by minute through the hours either side: London
    // (29 Mar 01:00 UTC, 25 Oct 01:00 UTC) and Cairo (its last Friday of April and last
    // Thursday of October, at midnight local).
    for (const [tz, at] of [
      ['Europe/London', Date.UTC(2026, 2, 29, 1)],
      ['Europe/London', Date.UTC(2026, 9, 25, 1)],
      ['Africa/Cairo', Date.UTC(2026, 3, 23, 22)],
      ['Africa/Cairo', Date.UTC(2026, 9, 29, 21)],
    ] as const) {
      sweep(tz, at - 3 * 3_600_000, 6 * 60 / 7, 7);
    }
  });

});
