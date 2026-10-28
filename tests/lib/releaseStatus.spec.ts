import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PurgeOutcome } from '@/lib/http/purge';
import { T, type Db, type Row } from '../fixtures/stagedDb';
import {
  ADMIN,
  OTHER_USER,
  auditRowsOf,
  callRoute,
  draftRow,
  makeDb,
} from '../fixtures/stagedRoute';

// The dashboard card's status and the purge retry by hand (Admin v2 R13) over the PostgREST
// stand-in. GET /api/admin/releases/status reads the live version, the next scheduled release,
// failed ones, the pending summary (counted as the savebar counts it) and the people's names,
// all as the person, and nothing but the flag while releases are off. POST
// /api/admin/releases/[id]/purge sends a published version's failed purge again through the one
// purge seam, records it as the cron does, and audits it when a request went out.

const svc = vi.hoisted(() => ({
  calls: [] as { fn: string; args: Record<string, unknown> }[],
}));
vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      svc.calls.push({ fn, args });
      return { data: null, error: null };
    },
  }),
}));
const logs = vi.hoisted(() => ({
  rows: [] as { level: string; source: string; message: string }[],
}));
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (row: { level: string; source: string; message: string }) => {
    logs.rows.push(row);
    return true;
  },
}));

// The retry's limiter slot (R13 review SEC-1): the ledger is the service role's, so the spec
// stands in for claimPrivilegedOp and records what was claimed.
const limiter = vi.hoisted(() => ({
  claims: [] as { op: string; limits: unknown }[],
  refuse: null as string | null,
}));
vi.mock('@/lib/admin/rateLimit', async (load) => {
  const actual = await load<typeof import('@/lib/admin/rateLimit')>();
  const { RateLimitError } = await import('@/lib/admin/errors');
  return {
    ...actual,
    claimPrivilegedOp: async (_auth: unknown, op: string, limits: unknown) => {
      limiter.claims.push({ op, limits });
      if (limiter.refuse) throw new RateLimitError(`${op}:${limiter.refuse}`);
    },
  };
});

const purge = vi.hoisted(() => ({
  outcome: null as PurgeOutcome | null,
  calls: [] as { tenant: string; tags: readonly string[]; source: string }[],
}));
vi.mock('@/lib/http/purge', async (load) => {
  const actual = await load<typeof import('@/lib/http/purge')>();
  return {
    ...actual,
    purgeTags: async (
      tenant: string,
      tags: readonly string[],
      options: Parameters<typeof actual.purgeTags>[2],
    ) => {
      purge.calls.push({ tenant, tags, source: options.source });
      return purge.outcome ?? actual.purgeTags(tenant, tags, options);
    },
  };
});

const { GET: STATUS } = await import('@/pages/api/admin/releases/status');
const { POST: RETRY } = await import('@/pages/api/admin/releases/[id]/purge');
const { ReleaseStatusAnswerSchema, PurgeRetryResultSchema } = await import('@schemas/release');
const { releaseStatus } = await import('@/lib/release/status');
const { RETRY_COPY, RELEASE_PURGE_OP } = await import('@/lib/release/purgeRetry');
const { RELEASE_PURGE_LIMITS } = await import('@/lib/admin/rateLimit');

const id = (n: number) => `0f0f0f0f-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BI = (en: string, ar: string) => ({ en, ar });
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

const release = (over: Row): Row => ({
  id: id(50),
  tenant_id: T,
  number: null,
  kind: 'publish',
  status: 'published',
  note: null,
  scheduled_for: null,
  scheduled_by: null,
  published_at: null,
  published_by: null,
  item_count: 1,
  areas: ['services'],
  tags: [],
  purge_status: 'done',
  purge_attempts: 1,
  created_at: ago(HOUR),
  updated_at: ago(HOUR),
  version: 1,
  ...over,
});

const SERVICES = [
  { id: id(1), tenant_id: T, slug: 'logo', title: BI('Logo', 'شعار'), status: 'published' },
  { id: id(2), tenant_id: T, slug: 'cards', title: BI('Cards', 'بطاقات'), status: 'published' },
  { id: id(3), tenant_id: T, slug: 'web', title: BI('Web', 'ويب'), status: 'published' },
];

function seed(tables: Record<string, Row[]> = {}): Db {
  return makeDb({
    services: structuredClone(SERVICES),
    staff_directory: [
      { id: ADMIN, display_name: 'Amal' },
      { id: OTHER_USER, display_name: 'Basel' },
    ],
    content_releases: [],
    ...tables,
  });
}

const draft = (n: number, over: Row) =>
  draftRow({ id: `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`, ...over });

beforeEach(() => {
  svc.calls = [];
  purge.outcome = null;
  purge.calls = [];
  logs.rows = [];
  limiter.claims = [];
  limiter.refuse = null;
});

describe('GET /api/admin/releases/status', () => {
  it('releases off: the flag is the only read, and the answer says off', async () => {
    const db = seed({ content_releases: [release({ number: 1, published_at: ago(HOUR) })] });
    db.flag = false;
    const res = await callRoute(db, STATUS, 'GET', '/api/admin/releases/status');
    expect(res.status).toBe(200);
    expect(ReleaseStatusAnswerSchema.parse(res.data)).toEqual({
      enabled: false,
      live: null,
      pending: { publishable: 0, waiting: 0, scheduled: 0 },
      next: null,
      failed: 0,
      cacheConnected: false,
      maintenance: null,
    });
    expect(db.calls).toEqual([expect.objectContaining({ kind: 'rpc', name: 'releases_enabled' })]);
  });

  it('on: the live version named, the savebar’s counts, the next schedule, failures in the window', async () => {
    const db = seed({
      content_releases: [
        release({
          id: id(51),
          number: 1,
          published_at: ago(3 * HOUR),
          published_by: OTHER_USER,
          purge_status: 'skipped',
        }),
        release({
          id: id(52),
          number: 2,
          note: 'Spring copy',
          published_at: ago(HOUR),
          published_by: ADMIN,
          purge_status: 'failed',
        }),
        release({
          id: id(53),
          status: 'scheduled',
          scheduled_for: ahead(48 * HOUR),
          scheduled_by: ADMIN,
          item_count: 4,
        }),
        release({
          id: id(54),
          status: 'scheduled',
          scheduled_for: ahead(2 * HOUR),
          scheduled_by: ADMIN,
          item_count: 2,
        }),
        release({ id: id(55), status: 'failed', updated_at: ago(2 * HOUR) }),
        // Older than the dashboard's seven days: not counted.
        release({ id: id(56), status: 'failed', updated_at: ago(8 * 24 * HOUR) }),
      ],
      content_drafts: [
        // Two sort-only edits of the services: ONE row, as the savebar counts it.
        draft(1, {
          entity_type: 'service',
          entity_id: id(1),
          fields: ['sort_order'],
          payload: { sortOrder: 2 },
        }),
        draft(2, {
          entity_type: 'service',
          entity_id: id(2),
          fields: ['sort_order'],
          payload: { sortOrder: 1 },
        }),
        // A removal only an Admin publishes: a Content Creator waits for one.
        draft(3, { entity_type: 'service', entity_id: id(3), op: 'delete', payload: {} }),
        // Locked by a scheduled release.
        draft(4, {
          entity_type: 'service',
          entity_id: id(1),
          fields: ['title'],
          payload: { title: BI('Logo design', 'تصميم الشعار') },
          release_id: id(54),
        }),
      ],
    });
    const res = await callRoute(db, STATUS, 'GET', '/api/admin/releases/status', {
      role: 'content_creator',
    });
    expect(res.status).toBe(200);
    const answer = ReleaseStatusAnswerSchema.parse(res.data);
    expect(answer.live).toEqual({
      id: id(52),
      number: 2,
      publishedAt: expect.any(String),
      publishedBy: { id: ADMIN, name: 'Amal' },
      note: 'Spring copy',
      purge: 'failed',
    });
    expect(answer.pending).toEqual({ publishable: 1, waiting: 1, scheduled: 1 });
    expect(answer.next).toEqual({
      id: id(54),
      scheduledFor: expect.any(String),
      changes: 2,
      total: 2,
    });
    expect(answer.failed).toBe(1);
    expect(answer.cacheConnected).toBe(false);
    // Every ledger read named the caller's tenant.
    const ledger = db.calls.filter((c) => c.kind === 'from' && c.name === 'content_releases');
    expect(ledger).toHaveLength(3);
  });

  it('an Admin publishes the removal: nothing waits', async () => {
    const db = seed({
      content_drafts: [
        draft(3, { entity_type: 'service', entity_id: id(3), op: 'delete', payload: {} }),
      ],
    });
    const res = await callRoute(db, STATUS, 'GET', '/api/admin/releases/status');
    expect(res.data['pending']).toEqual({ publishable: 1, waiting: 0, scheduled: 0 });
    expect(res.data['live']).toBeNull();
    expect(res.data['next']).toBeNull();
  });

  it('a Developer counts only the areas it reads (no service change)', async () => {
    const db = seed({
      content_drafts: [
        draft(3, { entity_type: 'service', entity_id: id(3), op: 'delete', payload: {} }),
      ],
    });
    const res = await callRoute(db, STATUS, 'GET', '/api/admin/releases/status', {
      role: 'developer',
    });
    expect(res.status).toBe(200);
    expect(res.data['pending']).toEqual({ publishable: 0, waiting: 0, scheduled: 0 });
  });

  it('Sales is refused by the kernel and reads nothing', async () => {
    const db = seed();
    const res = await callRoute(db, STATUS, 'GET', '/api/admin/releases/status', {
      role: 'sales',
    });
    expect(res.status).toBe(403);
    expect(db.calls).toEqual([]);
  });

  it('maintenance is what the edge holds; a read that throws is null', async () => {
    const db = seed();
    const ctx = {
      sb: (await import('../fixtures/stagedDb')).client(db),
      auth: { userId: ADMIN, tenantId: T, role: 'admin', isActive: true, email: 'a@x.test' },
      releasesEnabled: async () => true,
    } as unknown as Parameters<typeof releaseStatus>[0];
    expect((await releaseStatus(ctx, async () => true)).maintenance).toBe(true);
    expect(
      (
        await releaseStatus(ctx, async () => {
          throw new Error('kv');
        })
      ).maintenance,
    ).toBeNull();
  });
});

describe('POST /api/admin/releases/[id]/purge', () => {
  const failed = (over: Row = {}) =>
    release({
      number: 4,
      published_at: ago(HOUR),
      tags: ['service:logo', 'services:all'],
      purge_status: 'failed',
      purge_attempts: 2,
      ...over,
    });
  const call = (
    db: Db,
    role: 'admin' | 'content_creator' | 'seo' | 'developer' | 'sales' = 'admin',
  ) =>
    callRoute(db, RETRY, 'POST', `/api/admin/releases/${id(50)}/purge`, {
      body: {},
      role,
      params: { id: id(50) },
    });

  it('releases off: 409 and nothing is read or sent', async () => {
    const db = seed({ content_releases: [failed()] });
    db.flag = false;
    const res = await call(db);
    expect(res.status).toBe(409);
    expect(res.body['error']).toBe('releases-off');
    expect(db.calls.filter((c) => c.kind === 'from')).toEqual([]);
    expect(purge.calls).toEqual([]);
    expect(svc.calls).toEqual([]);
  });

  it('a version that is not the tenant’s, or not there: 404', async () => {
    const db = seed({
      content_releases: [failed({ tenant_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })],
    });
    expect((await call(db)).status).toBe(404);
    expect(purge.calls).toEqual([]);
  });

  it('nothing owed (done, skipped, pending, not needed, the baseline, not published): 409 not-owed', async () => {
    for (const over of [
      { purge_status: 'done' },
      { purge_status: 'skipped' },
      { purge_status: 'pending' },
      { purge_status: 'not_needed' },
      { kind: 'baseline' },
      { status: 'scheduled', number: null },
    ]) {
      const db = seed({ content_releases: [failed(over)] });
      const res = await call(db);
      expect(res.status, JSON.stringify(over)).toBe(409);
      expect(res.body).toEqual({ ok: false, error: 'not-owed', detail: RETRY_COPY.notOwed });
    }
    expect(purge.calls).toEqual([]);
    expect(svc.calls).toEqual([]);
    expect(limiter.claims).toEqual([]);
  });

  it('a failed purge, no cache set up: the stored tags, skipped, recorded and audited', async () => {
    const db = seed({ content_releases: [failed()] });
    const res = await call(db, 'content_creator');
    expect(res.status).toBe(200);
    expect(PurgeRetryResultSchema.parse(res.data)).toEqual({
      release: { id: id(50), number: 4 },
      purge: 'skipped',
      autoRetry: false,
    });
    expect(purge.calls).toEqual([
      { tenant: T, tags: ['service:logo', 'services:all'], source: 'release' },
    ]);
    expect(svc.calls).toEqual([
      {
        fn: 'record_release_purge',
        args: expect.objectContaining({
          p_tenant: T,
          p_release: id(50),
          p_status: 'skipped',
          p_tags: null,
          p_next_at: null,
        }),
      },
    ]);
    // The press changed the row (its purge now `skipped`), so the activity log says so.
    expect(auditRowsOf(db)).toEqual([
      expect.objectContaining({
        action: 'release.purge',
        entity_id: id(50),
        detail: { number: 4, status: 'skipped', tags: 2, retry: true, reason: 'not-set-up' },
      }),
    ]);
    expect(limiter.claims).toEqual([{ op: RELEASE_PURGE_OP, limits: RELEASE_PURGE_LIMITS }]);
  });

  it('a purge that went through: done, recorded, and audited as a retry by hand', async () => {
    purge.outcome = { status: 'done', tags: ['service:logo', 'services:all'], requests: 1 };
    const db = seed({ content_releases: [failed()] });
    const res = await call(db, 'seo');
    expect(res.status).toBe(200);
    expect(res.data['purge']).toBe('done');
    expect(res.data['autoRetry']).toBe(false);
    expect(svc.calls[0]?.args['p_status']).toBe('done');
    expect(auditRowsOf(db)).toEqual([
      expect.objectContaining({
        action: 'release.purge',
        entity_type: 'release',
        entity_id: id(50),
        detail: { number: 4, status: 'done', tags: 2, retry: true },
      }),
    ]);
  });

  it('failing again: due for the cron with its backoff; none after the tenth attempt', async () => {
    purge.outcome = { status: 'failed', tags: ['service:logo'], requests: 1, reason: 'http' };
    const again = seed({ content_releases: [failed()] });
    const first = await call(again);
    expect(typeof svc.calls[0]?.args['p_next_at']).toBe('string');
    expect(auditRowsOf(again)[0]?.['detail']).toMatchObject({ status: 'failed', reason: 'http' });
    expect(first.data['autoRetry']).toBe(true);
    expect(logs.rows.filter((r) => r.level === 'error')).toEqual([]);

    svc.calls = [];
    const last = seed({ content_releases: [failed({ purge_attempts: 9 })] });
    const tenth = await call(last);
    expect(svc.calls[0]?.args['p_next_at']).toBeNull();
    // The card and the page say the cron will not try again, and the end is logged as the
    // cron logs its own (R13 review C3, SEC-1).
    expect(tenth.data['autoRetry']).toBe(false);
    expect(logs.rows).toContainEqual(
      expect.objectContaining({
        level: 'error',
        source: 'release:purge',
        message: expect.stringContaining('will not be retried'),
      }),
    );
  });

  it('a press the seam sent nothing for (breaker, budget): 503, the version untouched, no audit row', async () => {
    for (const reason of ['breaker', 'budget', 'budget-unread'] as const) {
      purge.outcome = { status: 'failed', tags: ['service:logo'], requests: 0, reason };
      svc.calls = [];
      // Nine attempts: a press that counted would end the cron's retries.
      const db = seed({ content_releases: [failed({ purge_attempts: 9 })] });
      const res = await call(db, 'content_creator');
      expect(res.status, reason).toBe(503);
      expect(res.body, reason).toEqual({
        ok: false,
        error: 'purge-not-sent',
        detail: RETRY_COPY.notSent,
        reason,
      });
      expect(svc.calls, reason).toEqual([]);
      expect(auditRowsOf(db), reason).toEqual([]);
    }
  });

  it('the limiter: a slot per press, claimed after the checks; past it 429, the ledger down 503, nothing sent', async () => {
    expect(RELEASE_PURGE_LIMITS).toEqual({ perUser: 5, perTenant: 10, windowMinutes: 60 });
    for (const [refuse, status, error] of [
      ['user', 429, 'rate-limit'],
      ['tenant', 429, 'rate-limit'],
      ['unavailable', 503, 'unavailable'],
    ] as const) {
      limiter.refuse = refuse;
      const db = seed({ content_releases: [failed()] });
      const res = await call(db);
      expect(res.status, refuse).toBe(status);
      expect(res.body['error'], refuse).toBe(error);
      expect(res.body['detail'], refuse).toBe(
        refuse === 'unavailable' ? RETRY_COPY.ledger : RETRY_COPY.limited,
      );
      if (status === 429) expect(res.headers.get('retry-after')).toBe('3600');
      expect(auditRowsOf(db), refuse).toEqual([]);
    }
    expect(purge.calls).toEqual([]);
    expect(svc.calls).toEqual([]);
  });

  it('a version that kept no tags owes the whole site', async () => {
    const db = seed({ content_releases: [failed({ tags: [] })] });
    await call(db);
    expect(purge.calls[0]?.tags).toEqual(['tenant:default']);
  });

  it('Sales is refused by the kernel; every CMS role that publishes something passes it', async () => {
    const db = seed({ content_releases: [failed()] });
    expect((await call(db, 'sales')).status).toBe(403);
    for (const role of ['admin', 'content_creator', 'seo', 'developer'] as const) {
      expect((await call(seed({ content_releases: [failed()] }), role)).status, role).toBe(200);
    }
  });
});
