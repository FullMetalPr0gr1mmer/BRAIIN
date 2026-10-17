import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import type { Role } from '@/lib/auth/types';
import { AuthorizationError } from '@/lib/authz/errors';
import {
  collectionRoutes,
  itemRoutes,
  reorderRoute,
  type ResourceConfig,
} from '@/lib/admin/resource';
import {
  aiQuestionResource,
  clientResource,
  mediaResource,
  serviceResource,
} from '@/lib/admin/resources';
import { stageTransition } from '@/lib/release/staged';
import { DRAFT_AUDIT_WINDOW_MS, shouldAudit } from '@/lib/release/drafts';

// The staged branch of the resource kernel (Admin v2 R3a), driven through the real route
// factories over an in-memory stand-in for PostgREST: live tables, content_drafts, release
// items and the audit log, `rpc('releases_enabled')`, and `rpc('write_drafts')` emulated with
// the draft lock's rules (a new draft gets a fresh id and version 1; an edit lands on the
// version it named + 1; a claimed draft is untouchable; one draft per entity; all or nothing).
// With releases off every route must do exactly what it did before R3, and content_drafts is
// never touched; with releases on no live table is written.

vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

type Row = Record<string, unknown>;

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADMIN = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const S1 = '33333333-3333-4333-8333-333333333301';
const S2 = '33333333-3333-4333-8333-333333333302';
const S3 = '33333333-3333-4333-8333-333333333303';
const NEW_ID = '44444444-4444-4444-8444-444444444444';
const RELEASE = '55555555-5555-4555-8555-555555555555';

// ── The stand-in ──────────────────────────────────────────────────────────────────────────

interface Call {
  kind: 'from' | 'rpc';
  name: string;
  op?: string;
  values?: unknown;
}

interface Db {
  tables: Record<string, Row[]>;
  flag: boolean | 'error';
  calls: Call[];
  user: string;
  now: () => string;
}

let seq = 0;
const freshId = () => `66666666-6666-4666-8666-${String(++seq).padStart(12, '0')}`;

function topNames(list: string): string[] | null {
  if (list.trim() === '*') return null;
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of `${list},`) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      const name = current.trim();
      // An embed (`portfolio_services(…)`) is a join this stand-in does not do.
      if (name && !name.includes('(')) out.push(name.split(':')[0]!.trim());
      current = '';
    } else current += ch;
  }
  return out;
}

const project = (row: Row, names: string[] | null): Row => {
  if (!names) return { ...row };
  const out: Row = {};
  for (const n of names) if (n in row) out[n] = row[n];
  return out;
};

type Filter = [kind: 'eq' | 'neq' | 'is' | 'in' | 'ilike', column: string, value: unknown];

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every(([kind, column, value]) => {
    const v = row[column];
    if (kind === 'eq') return String(v) === String(value);
    if (kind === 'neq') return v !== null && v !== undefined && String(v) !== String(value);
    if (kind === 'is') return v === value;
    if (kind === 'in') return (value as unknown[]).map(String).includes(String(v));
    const term = String(value).replace(/^%|%$/g, '').replace(/\\(.)/g, '$1').toLowerCase();
    return typeof v === 'string' && v.toLowerCase().includes(term);
  });
}

function query(db: Db, table: string) {
  let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  let values: Row | null = null;
  let columns = '*';
  let returning = false;
  let count = false;
  let order: { column: string; ascending: boolean } | null = null;
  let range: [number, number] | null = null;
  let limit: number | null = null;
  const filters: Filter[] = [];

  const run = (): { data: Row[] | null; error: unknown; count?: number } => {
    db.calls.push({ kind: 'from', name: table, op, ...(values ? { values } : {}) });
    const rows = (db.tables[table] ??= []);
    if (op === 'insert') {
      const row = { id: freshId(), version: 1, ...values! };
      rows.push(row);
      return { data: [project(row, topNames(columns))], error: null };
    }
    const hit = rows.filter((r) => matches(r, filters));
    if (op === 'update') {
      for (const r of hit) Object.assign(r, values, { version: Number(r['version']) + 1 });
      return { data: returning ? hit.map((r) => project(r, topNames(columns))) : [], error: null };
    }
    if (op === 'delete') {
      db.tables[table] = rows.filter((r) => !hit.includes(r));
      return { data: hit.map((r) => project(r, topNames(columns))), error: null };
    }
    let out = [...hit];
    if (order) {
      const { column, ascending } = order;
      out.sort((a, b) => {
        const x = a[column] as number | string;
        const y = b[column] as number | string;
        return (x < y ? -1 : x > y ? 1 : 0) * (ascending ? 1 : -1);
      });
    }
    const total = out.length;
    if (range) out = out.slice(range[0], range[1] + 1);
    if (limit !== null) out = out.slice(0, limit);
    return {
      data: out.map((r) => project(r, topNames(columns))),
      error: null,
      ...(count ? { count: total } : {}),
    };
  };

  const b: Record<string, unknown> = {
    select(cols = '*', opts?: { count?: string }) {
      columns = cols;
      if (op !== 'select') returning = true;
      count = opts?.count === 'exact';
      return b;
    },
    eq: (c: string, v: unknown) => (filters.push(['eq', c, v]), b),
    neq: (c: string, v: unknown) => (filters.push(['neq', c, v]), b),
    is: (c: string, v: unknown) => (filters.push(['is', c, v]), b),
    in: (c: string, v: unknown[]) => (filters.push(['in', c, v]), b),
    ilike: (c: string, v: unknown) => (filters.push(['ilike', c, v]), b),
    order: (c: string, o?: { ascending?: boolean }) => (
      (order = { column: c, ascending: o?.ascending ?? true }),
      b
    ),
    range: (from: number, to: number) => ((range = [from, to]), b),
    limit: (n: number) => ((limit = n), b),
    insert: (v: Row) => ((op = 'insert'), (values = v), b),
    update: (v: Row) => ((op = 'update'), (values = v), b),
    delete: () => ((op = 'delete'), b),
    maybeSingle: async () => {
      const r = run();
      return { data: r.data?.[0] ?? null, error: r.error };
    },
    single: async () => {
      const r = run();
      return r.data?.[0]
        ? { data: r.data[0], error: null }
        : { data: null, error: { code: 'PGRST116', message: 'no row' } };
    },
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve(run())),
  };
  return b;
}

const br409 = (code: string, extra: Row = {}) => ({
  data: null,
  error: { code: 'BR409', message: 'conflict', details: JSON.stringify({ code, ...extra }) },
});

/** write_drafts with the draft lock's rules, all or nothing. */
function writeDraftsRpc(db: Db, args: Row) {
  if (args['p_tenant'] !== T) return { data: null, error: { code: '42501', message: 'tenant' } };
  const ops = [...(args['p_ops'] as Row[])].sort((a, b) =>
    `${a['entity_type'] ?? ''} ${a['entity_id'] ?? ''} ${a['draft_id'] ?? ''}`.localeCompare(
      `${b['entity_type'] ?? ''} ${b['entity_id'] ?? ''} ${b['draft_id'] ?? ''}`,
    ),
  );
  const drafts = structuredClone(db.tables['content_drafts'] ?? []);
  const out: Row[] = [];
  const now = db.now();
  for (const op of ops) {
    const find = () => drafts.find((d) => d['id'] === op['draft_id']);
    if (op['action'] === 'put' && !op['draft_id']) {
      if (
        drafts.some(
          (d) => d['entity_type'] === op['entity_type'] && d['entity_id'] === op['entity_id'],
        )
      ) {
        return br409('draft-conflict');
      }
      const row: Row = {
        id: freshId(),
        tenant_id: T,
        entity_type: op['entity_type'],
        entity_id: op['entity_id'],
        op: op['op'],
        payload: op['payload'],
        fields: op['fields'],
        base: op['base'],
        base_version: op['base_version'],
        label: op['label'],
        version: 1,
        created_at: now,
        updated_at: now,
        created_by: db.user,
        updated_by: db.user,
        release_id: null,
      };
      drafts.push(row);
      out.push({
        action: 'put',
        draft_id: row['id'],
        entity_type: row['entity_type'],
        entity_id: row['entity_id'],
        version: 1,
      });
      continue;
    }
    const d = find();
    if (!d || d['release_id'] || d['version'] !== op['expected_version']) {
      return br409(d?.['release_id'] ? 'scheduled' : 'draft-conflict');
    }
    if (op['action'] === 'put') {
      Object.assign(d, {
        op: op['op'],
        payload: op['payload'],
        fields: op['fields'],
        base: op['base'],
        base_version: op['base_version'],
        label: op['label'],
        version: Number(d['version']) + 1,
        updated_at: now,
        updated_by: db.user,
      });
      out.push({
        action: 'put',
        draft_id: d['id'],
        entity_type: d['entity_type'],
        entity_id: d['entity_id'],
        version: d['version'],
      });
    } else {
      drafts.splice(drafts.indexOf(d), 1);
      out.push({
        action: 'discard',
        draft_id: d['id'],
        entity_type: d['entity_type'],
        entity_id: d['entity_id'],
        version: null,
      });
    }
  }
  db.tables['content_drafts'] = drafts;
  return { data: out, error: null };
}

function client(db: Db) {
  return {
    from: (table: string) => query(db, table),
    rpc: async (fn: string, args: Row) => {
      db.calls.push({ kind: 'rpc', name: fn });
      if (fn === 'releases_enabled') {
        if (args['p_tenant'] !== T) return { data: false, error: null };
        return db.flag === 'error'
          ? { data: null, error: { code: 'PGRST202', message: 'no such function' } }
          : { data: db.flag, error: null };
      }
      if (fn === 'write_drafts') return writeDraftsRpc(db, args);
      return { data: null, error: { code: 'XX000', message: `unexpected rpc ${fn}` } };
    },
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────

const service = (over: Row = {}): Row => ({
  id: S1,
  tenant_id: T,
  slug: 'logo',
  title: { en: 'Logo', ar: 'شعار' },
  short_title: null,
  blurb: null,
  body: null,
  body_html: null,
  hero_video_uid: null,
  category: null,
  status: 'draft',
  is_teaser: false,
  sort_order: 10,
  version: 3,
  published_at: null,
  scheduled_for: null,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  discipline_id: null,
  intro: null,
  value_points: [],
  deliverables: [],
  poster_media_id: null,
  preview_video_path: null,
  preview_start_s: null,
  preview_end_s: null,
  ...over,
});

const draft = (over: Row): Row => ({
  id: freshId(),
  tenant_id: T,
  entity_type: 'service',
  entity_id: S1,
  op: 'update',
  payload: {},
  fields: [],
  base: {},
  base_version: 3,
  label: null,
  version: 1,
  created_at: '2026-10-17T08:00:00Z',
  updated_at: '2026-10-17T08:00:00Z',
  created_by: ADMIN,
  updated_by: ADMIN,
  release_id: null,
  ...over,
});

let db: Db;

beforeEach(() => {
  seq = 0;
  db = {
    tables: {
      services: [
        service(),
        service({ id: S2, slug: 'cards', title: { en: 'Cards' }, sort_order: 20, version: 1 }),
        service({ id: S3, slug: 'web', title: { en: 'Web' }, sort_order: 30, version: 1 }),
      ],
      content_drafts: [],
      content_release_items: [],
      audit_log: [],
    },
    flag: true,
    calls: [],
    user: ADMIN,
    now: () => new Date().toISOString(),
  };
});

afterEach(() => {
  vi.useRealTimers();
});

const collection = collectionRoutes(serviceResource);
const item = itemRoutes(serviceResource);
const services = {
  LIST: collection.GET,
  POST: collection.POST,
  GET: item.GET,
  PATCH: item.PATCH,
  DELETE: item.DELETE,
  REORDER: reorderRoute(serviceResource),
};

async function call(
  route: APIRoute,
  method: string,
  opts: { body?: unknown; id?: string; query?: string; role?: Role; user?: string } = {},
): Promise<{ status: number; body: Row; data: Row }> {
  const user = opts.user ?? ADMIN;
  db.user = user;
  const url = new URL(
    `https://admin.example.test/api/admin/services/${opts.id ?? ''}${opts.query ?? ''}`,
  );
  const ctx = {
    request: new Request(url, {
      method,
      ...(opts.body === undefined
        ? {}
        : { body: JSON.stringify(opts.body), headers: { 'content-type': 'application/json' } }),
    }),
    url,
    params: { id: opts.id },
    locals: {
      session: {
        userId: user,
        tenantId: T,
        role: opts.role ?? 'admin',
        isActive: true,
        email: 'a@example.test',
      },
      supabase: client(db),
      cspNonce: 'n',
      csrfToken: 'c',
    },
  } as unknown as Parameters<APIRoute>[0];
  const res = (await route(ctx)) as Response;
  const body = (await res.json()) as Row;
  return { status: res.status, body, data: (body['data'] ?? {}) as Row };
}

const drafts = () => db.tables['content_drafts']!;
const live = (id = S1) => db.tables['services']!.find((r) => r['id'] === id)!;
const audits = () => db.tables['audit_log']!.map((r) => r['action']);
const liveWrites = () =>
  db.calls.filter((c) => c.kind === 'from' && c.name === 'services' && c.op !== 'select');
const draftTouches = () =>
  db.calls.filter((c) => c.name === 'content_drafts' || c.name === 'write_drafts');
const editRef = (d: Row) => ({ draftId: d['id'], draftVersion: d['version'] });

// ── Releases off: the legacy path, unchanged ──────────────────────────────────────────────

describe('releases off: every route does what it did before R3', () => {
  beforeEach(() => {
    db.flag = false;
  });

  const trace = () =>
    db.calls
      .filter((c) => !(c.kind === 'rpc' && c.name === 'releases_enabled'))
      .map((c) => `${c.kind === 'rpc' ? 'rpc' : c.op} ${c.name}`);
  const flagReads = () => db.calls.filter((c) => c.name === 'releases_enabled').length;

  it('POST inserts the live row, as toRow writes it, and audits the create', async () => {
    const body = { slug: 'motion', title: { en: 'Motion', ar: 'موشن' }, status: 'draft' };
    const res = await call(services.POST, 'POST', { body });
    expect(res.status).toBe(200);
    expect(trace()).toEqual(['insert services', 'insert audit_log']);
    expect(db.calls.find((c) => c.op === 'insert' && c.name === 'services')?.values).toEqual({
      ...serviceResource.toRow(serviceResource.createSchema.parse(body)),
      tenant_id: T,
    });
    expect(audits()).toEqual(['service.create']);
    expect(flagReads()).toBe(1);
    expect(draftTouches()).toEqual([]);
  });

  it('PATCH reads the stored row, updates it at its version and audits the update', async () => {
    const res = await call(services.PATCH, 'PATCH', {
      id: S1,
      body: { title: { en: 'Logos', ar: 'شعارات' }, version: 3 },
    });
    expect(res.status).toBe(200);
    expect(trace()).toEqual([
      'select services',
      'select services',
      'update services',
      'insert audit_log',
    ]);
    expect(live()['title']).toEqual({ en: 'Logos', ar: 'شعارات' });
    expect(live()['version']).toBe(4);
    expect(audits()).toEqual(['service.update']);
    expect(draftTouches()).toEqual([]);
  });

  it('PATCH keeps the kernel parse: a body the update schema refuses is the same 422', async () => {
    const res = await call(services.PATCH, 'PATCH', { id: S1, body: { title: 'x' } });
    expect(res.status).toBe(422);
    expect(res.body['error']).toBe('validation');
    expect(liveWrites()).toEqual([]);
  });

  it('PATCH at an old version is the same 409 conflict', async () => {
    const res = await call(services.PATCH, 'PATCH', {
      id: S1,
      body: { title: { en: 'X', ar: 'س' }, version: 2 },
    });
    expect([res.status, res.body['error']]).toEqual([409, 'conflict']);
  });

  it('DELETE removes the live row; reorder updates each row; GETs read live', async () => {
    expect((await call(services.DELETE, 'DELETE', { id: S2 })).status).toBe(200);
    expect(db.tables['services']!.some((r) => r['id'] === S2)).toBe(false);
    const re = await call(services.REORDER, 'POST', {
      body: {
        items: [
          { id: S1, sortOrder: 5 },
          { id: S3, sortOrder: 1 },
        ],
      },
    });
    expect(re.data).toEqual({ reordered: 2 });
    expect([live(S1)['sort_order'], live(S3)['sort_order']]).toEqual([5, 1]);
    const list = await call(services.LIST, 'GET');
    expect(list.data['total']).toBe(2);
    expect(list.data).not.toHaveProperty('draftsTruncated');
    const one = await call(services.GET, 'GET', { id: S1 });
    expect(one.data['slug']).toBe('logo');
    expect(one.data).not.toHaveProperty('draft');
    expect(audits()).toEqual(['service.delete', 'service.reorder']);
    expect(draftTouches()).toEqual([]);
  });

  it('persist, afterWrite and afterDelete still run', async () => {
    const persist = vi.fn(async () => service({ id: NEW_ID }));
    const afterWrite = vi.fn(async () => ({ kvSynced: true }));
    const afterDelete = vi.fn(async () => ({ kvSynced: true }));
    const config: ResourceConfig = { ...serviceResource, persist, afterWrite, afterDelete };
    await call(collectionRoutes(config).POST, 'POST', {
      body: { slug: 'motion', title: { en: 'Motion', ar: 'موشن' } },
    });
    await call(itemRoutes(config).DELETE, 'DELETE', { id: S2 });
    expect([
      persist.mock.calls.length,
      afterWrite.mock.calls.length,
      afterDelete.mock.calls.length,
    ]).toEqual([1, 1, 1]);
  });
});

// ── Releases on: the flag read ────────────────────────────────────────────────────────────

describe('the flag', () => {
  it('is read once per request, through the caller’s own tenant', async () => {
    await call(services.PATCH, 'PATCH', {
      id: S1,
      body: { title: { en: 'A', ar: 'أ' }, version: 3 },
    });
    expect(db.calls.filter((c) => c.name === 'releases_enabled')).toHaveLength(1);
  });

  it('an error reading it is a 500 and nothing is written, live or staged', async () => {
    db.flag = 'error';
    for (const [route, method, opts] of [
      [services.POST, 'POST', { body: { slug: 'm', title: { en: 'M', ar: 'م' } } }],
      [services.PATCH, 'PATCH', { id: S1, body: { title: { en: 'A', ar: 'أ' }, version: 3 } }],
      [services.DELETE, 'DELETE', { id: S1 }],
      [services.REORDER, 'POST', { body: { items: [{ id: S1, sortOrder: 1 }] } }],
    ] as const) {
      expect((await call(route, method, opts)).status).toBe(500);
    }
    expect(liveWrites()).toEqual([]);
    expect(draftTouches()).toEqual([]);
  });

  it('media and Style-Finder configs never ask it and never stage', async () => {
    db.tables['media_assets'] = [];
    db.tables['ai_questions'] = [];
    const media = collectionRoutes(mediaResource);
    const ai = collectionRoutes(aiQuestionResource);
    await call(media.GET, 'GET');
    await call(ai.GET, 'GET');
    expect(db.calls.filter((c) => c.kind === 'rpc')).toEqual([]);
    expect(draftTouches()).toEqual([]);
  });
});

// ── Releases on: create ───────────────────────────────────────────────────────────────────

describe('releases on: POST stages a create', () => {
  const body = { slug: 'motion', title: { en: 'Motion', ar: 'موشن' }, status: 'draft' };

  it('under a Worker id (a client id ignored), version 0, no live row', async () => {
    const res = await call(services.POST, 'POST', { body: { ...body, id: NEW_ID } });
    expect(res.status).toBe(200);
    expect(liveWrites()).toEqual([]);
    expect(drafts()).toHaveLength(1);
    const d = drafts()[0]!;
    expect(d['op']).toBe('create');
    expect(d['entity_id']).not.toBe(NEW_ID);
    expect(d['entity_id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(d['base']).toEqual({});
    expect(d['base_version']).toBeNull();
    expect(d['payload']).toMatchObject({ slug: 'motion', status: 'draft' });
    expect(d['payload']).not.toHaveProperty('id');
    expect(d['label']).toEqual({ en: 'Motion', ar: 'موشن' });
    expect(res.data).toMatchObject({ id: d['entity_id'], version: 0, slug: 'motion' });
    expect(res.data['draft']).toMatchObject({ id: d['id'], version: 1, op: 'create' });
    expect(audits()).toEqual(['service.draft_save']);
    expect(db.tables['audit_log']![0]!['detail']).toMatchObject({ op: 'create', status: 'draft' });
  });

  it('a published create needs content.publish; an archived one content.archiveDelete', async () => {
    const res = await call(services.POST, 'POST', {
      body: { ...body, status: 'archived' },
      role: 'content_creator',
    });
    expect([res.status, res.body['capability']]).toEqual([403, 'content.archiveDelete']);
    expect(() =>
      stageTransition(
        { userId: ADMIN, tenantId: T, role: 'developer', isActive: true, email: 'd@x.test' },
        serviceResource,
        { status: 'published' },
      ),
    ).toThrow(AuthorizationError);
    expect(drafts()).toEqual([]);
  });

  it('`visible: true` on a visible-published entity needs content.publish', () => {
    const developer = {
      userId: ADMIN,
      tenantId: T,
      role: 'developer' as const,
      isActive: true,
      email: 'd@x.test',
    };
    expect(() => stageTransition(developer, clientResource, { visible: true })).toThrow(
      AuthorizationError,
    );
    expect(() => stageTransition(developer, clientResource, { visible: false })).not.toThrow();
  });

  it('a scheduled create is refused: schedule the release instead', async () => {
    const res = await call(services.POST, 'POST', {
      body: { ...body, status: 'scheduled', scheduledFor: '2026-12-01T00:00:00Z' },
    });
    expect(res.status).toBe(422);
    expect(res.body['detail']).toBe('Schedule the release instead');
    expect(drafts()).toEqual([]);
  });

  it('a published create stages no published_at (the apply stamps it)', async () => {
    await call(services.POST, 'POST', { body: { ...body, status: 'published' } });
    const d = drafts()[0]!;
    expect(d['fields']).toContain('status');
    expect(d['fields']).not.toContain('published_at');
    expect(JSON.stringify(d['payload'])).not.toContain('published_at');
  });
});

// ── Releases on: PATCH ────────────────────────────────────────────────────────────────────

describe('releases on: PATCH stages an edit', () => {
  const title = (en: string) => ({ title: { en, ar: 'شعار' } });

  it('the first edit checks the live version, records the base and writes no live row', async () => {
    const res = await call(services.PATCH, 'PATCH', {
      id: S1,
      body: { ...title('Logos'), version: 3 },
    });
    expect(res.status).toBe(200);
    expect(liveWrites()).toEqual([]);
    const d = drafts()[0]!;
    expect(d).toMatchObject({ op: 'update', base_version: 3, fields: ['title'] });
    expect(d['base']).toEqual({ title: { en: 'Logo', ar: 'شعار' } });
    expect(d['payload']).toEqual({ title: { en: 'Logos', ar: 'شعار' } });
    expect(res.data).toMatchObject({ id: S1, version: 3, title: { en: 'Logos', ar: 'شعار' } });
    expect(res.data['draft']).toMatchObject({
      id: d['id'],
      version: 1,
      op: 'update',
      fields: ['title'],
    });
    expect(audits()).toEqual(['service.draft_save']);
  });

  it('an old live version is 409 conflict, as today', async () => {
    const res = await call(services.PATCH, 'PATCH', {
      id: S1,
      body: { ...title('X'), version: 2 },
    });
    expect([res.status, res.body['error']]).toEqual([409, 'conflict']);
    expect(drafts()).toEqual([]);
  });

  it('with a draft pending, a save must name it at its version (409 draft-conflict)', async () => {
    const d = draft({
      payload: title('Logos'),
      base: { title: { en: 'Logo', ar: 'شعار' } },
      version: 2,
    });
    drafts().push(d);
    const none = await call(services.PATCH, 'PATCH', {
      id: S1,
      body: { ...title('A'), version: 3 },
    });
    expect([none.status, none.body['error']]).toEqual([409, 'draft-conflict']);
    const old = await call(services.PATCH, 'PATCH', {
      id: S1,
      body: { ...title('A'), version: 3, draftId: d['id'], draftVersion: 1 },
    });
    expect([old.status, old.body['error']]).toEqual([409, 'draft-conflict']);
    const ok = await call(services.PATCH, 'PATCH', {
      id: S1,
      body: { ...title('A'), version: 3, ...editRef(d) },
    });
    expect(ok.status).toBe(200);
    expect(drafts()[0]!['version']).toBe(3);
  });

  it('a draft ref sent alone is refused (both or neither)', async () => {
    const res = await call(services.PATCH, 'PATCH', {
      id: S1,
      body: { ...title('A'), version: 3, draftId: NEW_ID },
    });
    expect(res.status).toBe(422);
  });

  it('a draft claimed by a scheduled release is 409 scheduled', async () => {
    const d = draft({
      payload: title('Logos'),
      base: { title: live()['title'] },
      release_id: RELEASE,
    });
    drafts().push(d);
    const res = await call(services.PATCH, 'PATCH', {
      id: S1,
      body: { ...title('A'), version: 3, ...editRef(d) },
    });
    expect([res.status, res.body['error']]).toEqual([409, 'scheduled']);
  });

  it('a draft that left: published (a release item names it) or discarded, with the live row', async () => {
    db.tables['content_release_items']!.push({ id: 1, tenant_id: T, draft_id: NEW_ID });
    const published = await call(services.PATCH, 'PATCH', {
      id: S1,
      body: { ...title('A'), version: 3, draftId: NEW_ID, draftVersion: 2 },
    });
    expect([published.status, published.body['error']]).toEqual([409, 'draft-published']);
    expect(published.body['live']).toMatchObject({ id: S1, title: { en: 'Logo', ar: 'شعار' } });
    const gone = await call(services.PATCH, 'PATCH', {
      id: S1,
      body: { ...title('A'), version: 3, draftId: S2, draftVersion: 2 },
    });
    expect([gone.status, gone.body['error']]).toEqual([409, 'draft-discarded']);
    expect(gone.body['live']).toMatchObject({ id: S1 });
  });

  it('a pending removal is not edited (409, undo the removal first)', async () => {
    const d = draft({ op: 'delete' });
    drafts().push(d);
    const res = await call(services.PATCH, 'PATCH', {
      id: S1,
      body: { ...title('A'), version: 3, ...editRef(d) },
    });
    expect([res.status, res.body['error']]).toEqual([409, 'draft-conflict']);
    expect(String(res.body['detail'])).toContain('Undo the removal');
  });

  it('a save that sets everything back to live throws the pending change away', async () => {
    const d = draft({
      payload: title('Logos'),
      base: { title: live()['title'] },
      fields: ['title'],
    });
    drafts().push(d);
    const res = await call(services.PATCH, 'PATCH', {
      id: S1,
      body: { ...title('Logo'), version: 3, ...editRef(d) },
    });
    expect(res.status).toBe(200);
    expect(res.data['draft']).toBeNull();
    expect(drafts()).toEqual([]);
    expect(audits()).toEqual(['service.draft_discard']);
    expect(db.tables['audit_log']![0]!['detail']).toEqual({ op: 'update', reason: 'no-op' });
  });

  it('a save equal to live with no draft pending writes nothing', async () => {
    const res = await call(services.PATCH, 'PATCH', {
      id: S1,
      body: { ...title('Logo'), version: 3 },
    });
    expect(res.status).toBe(200);
    expect(res.data['draft']).toBeNull();
    expect(draftTouches().filter((c) => c.name === 'write_drafts')).toEqual([]);
  });

  it('the base is recorded once, never overwritten, and a moved live column shows as a conflict', async () => {
    await call(services.PATCH, 'PATCH', { id: S1, body: { ...title('Logos'), version: 3 } });
    // A colleague's live edit lands under the draft (the guard, R5, will refuse it; here the
    // database is changed directly).
    Object.assign(live(), { title: { en: 'Brand marks', ar: 'شعار' }, version: 4 });
    const d = drafts()[0]!;
    const res = await call(services.PATCH, 'PATCH', {
      id: S1,
      body: { ...title('Logos!'), slug: 'logos', version: 4, ...editRef(d) },
    });
    expect(res.status).toBe(200);
    const after = drafts()[0]!;
    expect(after['base']).toEqual({ title: { en: 'Logo', ar: 'شعار' }, slug: 'logo' });
    expect(after['base_version']).toBe(3);
    expect(after['fields']).toEqual(['slug', 'title']);
    expect((res.data['draft'] as Row)['conflict']).toEqual(['title']);
  });

  it('the base covers every patched column, read over the allowlist (not the config’s select)', async () => {
    // A config that selects almost nothing: the staged read widens it to the allowlist.
    const narrow: ResourceConfig = { ...serviceResource, columns: 'id,version' };
    const res = await call(itemRoutes(narrow).PATCH, 'PATCH', {
      id: S1,
      body: { slug: 'logo-design', category: 'brand', isTeaser: true, sortOrder: 11, version: 3 },
    });
    expect(res.status).toBe(200);
    const d = drafts()[0]!;
    const base = d['base'] as Row;
    for (const column of Object.keys(base)) expect(base[column], column).toEqual(live()[column]);
    expect(Object.keys(base).sort()).toEqual(['category', 'is_teaser', 'slug', 'sort_order']);
  });

  it('publishing stages the status, never published_at; archiving needs Admin', async () => {
    const res = await call(services.PATCH, 'PATCH', {
      id: S1,
      body: { status: 'published', version: 3 },
    });
    expect(res.status).toBe(200);
    expect(drafts()[0]!['fields']).toEqual(['status']);
    expect(drafts()[0]!['base']).toEqual({ status: 'draft' });
    const cc = await call(services.PATCH, 'PATCH', {
      id: S2,
      body: { status: 'archived', version: 1 },
      role: 'content_creator',
    });
    expect([cc.status, cc.body['capability']]).toEqual([403, 'content.archiveDelete']);
  });

  it('the status rule judges the whole pending change, not only this save', async () => {
    // An Admin staged an archive; a Content Creator's title edit would re-save it.
    const d = draft({
      payload: { status: 'archived' },
      base: { status: 'draft' },
      fields: ['status'],
    });
    drafts().push(d);
    const res = await call(services.PATCH, 'PATCH', {
      id: S1,
      body: { ...title('Logos'), version: 3, ...editRef(d) },
      role: 'content_creator',
    });
    expect([res.status, res.body['capability']]).toEqual([403, 'content.archiveDelete']);
    expect(drafts()[0]!['version']).toBe(1);
    const moved = await call(services.REORDER, 'POST', {
      body: { items: [{ id: S1, sortOrder: 1 }] },
      role: 'content_creator',
    });
    expect(moved.status).toBe(403);
    expect(drafts()[0]!['version']).toBe(1);
  });

  it('a pending create is edited in place: its payload stays a full create', async () => {
    await call(services.POST, 'POST', {
      body: { slug: 'motion', title: { en: 'Motion', ar: 'موشن' } },
    });
    const d = drafts()[0]!;
    const res = await call(services.PATCH, 'PATCH', {
      id: String(d['entity_id']),
      body: { blurb: { en: 'Moving pictures' }, ...editRef(d) },
    });
    expect(res.status).toBe(200);
    const after = drafts()[0]!;
    expect(after).toMatchObject({ op: 'create', version: 2, base: {}, base_version: null });
    expect(after['payload']).toMatchObject({ slug: 'motion', blurb: { en: 'Moving pictures' } });
    expect(res.data).toMatchObject({ version: 0, slug: 'motion' });
  });

  it('persist and afterWrite never run when staged', async () => {
    const persist = vi.fn();
    const afterWrite = vi.fn();
    const afterDelete = vi.fn();
    const config: ResourceConfig = { ...serviceResource, persist, afterWrite, afterDelete };
    await call(collectionRoutes(config).POST, 'POST', {
      body: { slug: 'm', title: { en: 'M', ar: 'م' } },
    });
    await call(itemRoutes(config).PATCH, 'PATCH', {
      id: S2,
      body: { slug: 'cards-2', version: 1 },
    });
    await call(itemRoutes(config).DELETE, 'DELETE', { id: S3 });
    expect([persist, afterWrite, afterDelete].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);
    expect(liveWrites()).toEqual([]);
  });

  it('an unknown item is 404', async () => {
    const res = await call(services.PATCH, 'PATCH', {
      id: NEW_ID,
      body: { ...title('A'), version: 1 },
    });
    expect(res.status).toBe(404);
  });
});

// ── Releases on: DELETE ───────────────────────────────────────────────────────────────────

describe('releases on: DELETE', () => {
  it('stages a removal of a live row, replacing a pending edit, and keeps the row live', async () => {
    const d = draft({ payload: { slug: 'logo-2' }, base: { slug: 'logo' }, fields: ['slug'] });
    drafts().push(d);
    const res = await call(services.DELETE, 'DELETE', { id: S1 });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ deleted: S1, pendingRemoval: true });
    expect(drafts()).toHaveLength(1);
    expect(drafts()[0]).toMatchObject({
      id: d['id'],
      op: 'delete',
      payload: {},
      base: {},
      version: 2,
    });
    expect(live()).toBeDefined();
    expect(audits()).toEqual(['service.draft_save']);
    expect(db.tables['audit_log']![0]!['detail']).toEqual({ op: 'delete', replaced: ['slug'] });
  });

  it('discards a pending create', async () => {
    await call(services.POST, 'POST', { body: { slug: 'm', title: { en: 'M', ar: 'م' } } });
    const id = String(drafts()[0]!['entity_id']);
    const res = await call(services.DELETE, 'DELETE', { id });
    expect(res.data).toEqual({ deleted: id, draft: null });
    expect(drafts()).toEqual([]);
    expect(audits()).toEqual(['service.draft_save', 'service.draft_discard']);
  });

  it('a draftVersion that moved is 409; a claimed draft is 409 scheduled', async () => {
    const d = draft({ payload: { slug: 'x' }, base: { slug: 'logo' } });
    drafts().push(d);
    const moved = await call(services.DELETE, 'DELETE', { id: S1, query: '?draftVersion=7' });
    expect([moved.status, moved.body['error']]).toEqual([409, 'draft-conflict']);
    d['release_id'] = RELEASE;
    const claimed = await call(services.DELETE, 'DELETE', { id: S1 });
    expect([claimed.status, claimed.body['error']]).toEqual([409, 'scheduled']);
  });

  it('still needs the delete capability (Content Creator 403)', async () => {
    const res = await call(services.DELETE, 'DELETE', { id: S1, role: 'content_creator' });
    expect(res.status).toBe(403);
    expect(drafts()).toEqual([]);
  });
});

// ── Releases on: reorder ──────────────────────────────────────────────────────────────────

describe('releases on: reorder', () => {
  it('one writer call; positions equal to live dropped; pending removals skipped', async () => {
    drafts().push(draft({ entity_id: S3, op: 'delete' }));
    const res = await call(services.REORDER, 'POST', {
      body: {
        items: [
          { id: S1, sortOrder: 10 }, // unchanged
          { id: S2, sortOrder: 5 },
          { id: S3, sortOrder: 1 }, // pending removal
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ reordered: 3, staged: 1, discarded: 0 });
    expect(db.calls.filter((c) => c.name === 'write_drafts')).toHaveLength(1);
    const staged = drafts().find((d) => d['entity_id'] === S2)!;
    expect(staged).toMatchObject({
      op: 'update',
      payload: { sortOrder: 5 },
      base: { sort_order: 20 },
    });
    expect(drafts().some((d) => d['entity_id'] === S1)).toBe(false);
    expect(liveWrites()).toEqual([]);
    expect(audits()).toEqual(['service.draft_save']);
    expect(db.tables['audit_log']![0]!['detail']).toEqual({ op: 'reorder', count: 3 });
  });

  it('a move back to the live position discards a sort-only draft; other pending edits keep theirs', async () => {
    drafts().push(
      draft({
        entity_id: S1,
        payload: { sortOrder: 99 },
        base: { sort_order: 10 },
        fields: ['sort_order'],
      }),
      draft({
        entity_id: S2,
        payload: { sortOrder: 99, slug: 'cards-2' },
        base: { sort_order: 20, slug: 'cards' },
        base_version: 1,
      }),
    );
    const res = await call(services.REORDER, 'POST', {
      body: {
        items: [
          { id: S1, sortOrder: 10 },
          { id: S2, sortOrder: 20 },
        ],
      },
    });
    expect(res.data).toEqual({ reordered: 2, staged: 1, discarded: 1 });
    expect(drafts()).toHaveLength(1);
    expect(drafts()[0]).toMatchObject({
      entity_id: S2,
      payload: { slug: 'cards-2' },
      base: { slug: 'cards' },
    });
  });
});

// ── Releases on: reads ────────────────────────────────────────────────────────────────────

describe('releases on: reorder judges the whole pending change', () => {
  it('a Content Creator moving a row an Admin staged for archiving is 403, nothing written', async () => {
    drafts().push(
      draft({
        entity_id: S2,
        payload: { status: 'archived' },
        base: { status: 'draft' },
        base_version: 1,
      }),
    );
    const res = await call(services.REORDER, 'POST', {
      body: {
        items: [
          { id: S1, sortOrder: 1 },
          { id: S2, sortOrder: 2 },
        ],
      },
      role: 'content_creator',
    });
    expect([res.status, res.body['capability']]).toEqual([403, 'content.archiveDelete']);
    expect(db.calls.filter((c) => c.name === 'write_drafts')).toEqual([]);
    expect(drafts()).toHaveLength(1);
    expect(audits()).toEqual([]);
  });
});

describe('releases on: reads lay the pending change over live', () => {
  it('GET item: an edit, a create, a removal, a conflict and a row removed under its change', async () => {
    const GET = services.GET;
    drafts().push(
      draft({ entity_id: S1, payload: { slug: 'logo-2' }, base: { slug: 'logo' } }),
      draft({ entity_id: S2, op: 'delete' }),
      draft({ entity_id: S3, payload: { slug: 'web-2' }, base: { slug: 'website' } }),
      draft({
        entity_id: NEW_ID,
        op: 'create',
        base_version: null,
        payload: { slug: 'new', title: { en: 'New', ar: 'جديد' } },
      }),
      draft({ entity_id: RELEASE, payload: { slug: 'gone' }, base: { slug: 'was' } }),
    );
    const edit = await call(GET, 'GET', { id: S1 });
    expect(edit.data).toMatchObject({ slug: 'logo-2', version: 3, draft: { op: 'update' } });
    const removal = await call(GET, 'GET', { id: S2 });
    expect(removal.data).toMatchObject({
      slug: 'cards',
      pendingRemoval: true,
      draft: { op: 'delete' },
    });
    const conflict = await call(GET, 'GET', { id: S3 });
    expect((conflict.data['draft'] as Row)['conflict']).toEqual(['slug']);
    const created = await call(GET, 'GET', { id: NEW_ID });
    expect(created.data).toMatchObject({
      id: NEW_ID,
      version: 0,
      slug: 'new',
      draft: { op: 'create' },
    });
    const missing = await call(GET, 'GET', { id: RELEASE });
    expect(missing.data).toMatchObject({ id: RELEASE, draft: { liveMissing: true } });
    const neither = await call(GET, 'GET', { id: '77777777-7777-4777-8777-777777777777' });
    expect(neither.status).toBe(404);
    const plain = await call(GET, 'GET', { id: S1, query: '' });
    expect(plain.status).toBe(200);
  });

  it('GET list: totals count matching creates, filters apply, invalid drafts are reported', async () => {
    drafts().push(
      draft({ entity_id: S1, payload: { slug: 'logo-2' }, base: { slug: 'logo' } }),
      draft({ entity_id: S2, op: 'delete' }),
      draft({
        entity_id: NEW_ID,
        op: 'create',
        base_version: null,
        payload: { slug: 'new', title: { en: 'New', ar: 'جديد' } },
      }),
      draft({ id: '88888888-8888-4888-8888-888888888888', entity_id: S3, payload: { slug: 42 } }),
    );
    const all = await call(services.LIST, 'GET');
    expect(all.status).toBe(200);
    expect(all.data['total']).toBe(4);
    const rows = all.data['rows'] as Row[];
    expect(rows.map((r) => r['slug'])).toEqual(['new', 'logo-2', 'cards', 'web']);
    expect(rows.find((r) => r['id'] === S2)).toMatchObject({ pendingRemoval: true });
    expect(all.data['draftsInvalid']).toEqual(['88888888-8888-4888-8888-888888888888']);
    expect(all.data['draftsTruncated']).toBe(false);
    const published = await call(services.LIST, 'GET', { query: '?status=published' });
    expect(published.data['total']).toBe(0);
  });
});

// ── The audit row ─────────────────────────────────────────────────────────────────────────

describe('audit: one draft_save per draft per person per ten minutes', () => {
  it('a second save by the same person soon after is not a new row; another person’s is', async () => {
    await call(services.PATCH, 'PATCH', { id: S1, body: { slug: 'a', version: 3 } });
    let d = drafts()[0]!;
    await call(services.PATCH, 'PATCH', { id: S1, body: { slug: 'b', version: 3, ...editRef(d) } });
    expect(audits()).toEqual(['service.draft_save']);
    d = drafts()[0]!;
    await call(services.PATCH, 'PATCH', {
      id: S1,
      body: { slug: 'c', version: 3, ...editRef(d) },
      user: OTHER_USER,
    });
    expect(audits()).toEqual(['service.draft_save', 'service.draft_save']);
    // Values never reach the audit row: field names only.
    expect(JSON.stringify(db.tables['audit_log'])).not.toContain('"c"');
  });

  it('shouldAudit: no draft, another person, another op or ten minutes later writes a row', () => {
    const auth = {
      userId: ADMIN,
      tenantId: T,
      role: 'admin' as const,
      isActive: true,
      email: 'a@x.test',
    };
    const now = Date.parse('2026-10-17T10:00:00Z');
    const prev = { updated_by: ADMIN, updated_at: '2026-10-17T09:55:00Z', op: 'update' as const };
    expect(shouldAudit(null, auth, 'update', now)).toBe(true);
    expect(shouldAudit(prev, auth, 'update', now)).toBe(false);
    expect(shouldAudit({ ...prev, updated_by: OTHER_USER }, auth, 'update', now)).toBe(true);
    expect(shouldAudit(prev, auth, 'delete', now)).toBe(true);
    expect(shouldAudit(prev, auth, 'update', now + DRAFT_AUDIT_WINDOW_MS)).toBe(true);
  });
});
