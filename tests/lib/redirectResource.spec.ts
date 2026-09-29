import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIRoute } from 'astro';
import { collectionRoutes, itemRoutes } from '@/lib/admin/resource';
import { redirectResource } from '@/lib/admin/resources';
import { REDIRECTS_KV_KEY } from '@/lib/http/redirects';
import type { Role } from '@/lib/auth/types';
import { env as stubEnv, __kv } from '../stubs/cloudflare-workers';

// The redirect resource end to end through the kernel (Round 3, item A): the domain
// rules on the MERGED row, and the edge snapshot every save and delete rebuilds. The
// database is a small in-memory fake that answers the exact queries the resource and
// the sync make; KV is the shared stub the middleware spec reads from too.

const { audits, systemLog } = vi.hoisted(() => ({
  audits: [] as Record<string, unknown>[],
  systemLog: vi.fn(async (_entry: Record<string, unknown>) => true),
}));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: systemLog }));
vi.mock('@/lib/admin/audit', () => ({
  writeAudit: async (_sb: unknown, _ctx: unknown, entry: Record<string, unknown>) => {
    audits.push(entry);
    return true;
  },
}));

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

interface RedirectRow extends Record<string, unknown> {
  id: string;
  source_path: string;
  target_path: string;
  status: number;
  version: number;
}

interface Fake {
  redirects: RedirectRow[];
  /** Live slugs per content table, for the live-slug refusal. */
  live: Record<string, string[]>;
}

type Filter = { op: string; column: string; value: unknown };

/** A PostgREST stand-in that evaluates the filters the resource actually applies. */
function fakeDb(state: Fake) {
  return {
    from(table: string) {
      const filters: Filter[] = [];
      let written: Record<string, unknown> | null = null;
      let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
      let head = false;

      let limit = Infinity;
      let orderBy: string | null = null;

      const rowsOf = (): Record<string, unknown>[] => {
        if (table === 'redirects') {
          const rows = state.redirects.filter((row) =>
            filters.every((f) => {
              if (f.column === 'tenant_id') return f.value === TENANT;
              const cell = String(row[f.column as keyof RedirectRow]);
              if (f.op === 'eq') return cell === String(f.value);
              if (f.op === 'in') return (f.value as unknown[]).map(String).includes(cell);
              return true;
            }),
          );
          if (orderBy) rows.sort((a, b) => String(a[orderBy!]).localeCompare(String(b[orderBy!])));
          return rows.slice(0, limit);
        }
        const slug = filters.find((f) => f.column === 'slug')?.value;
        const live = state.live[table] ?? [];
        return typeof slug === 'string' && live.includes(slug) ? [{ id: OTHER }] : [];
      };

      const resolve = () => {
        if (op === 'insert') {
          const row = { id: ID, version: 1, ...written } as RedirectRow;
          state.redirects.push(row);
          return { data: [row], error: null, count: 1 };
        }
        if (op === 'update') {
          const rows = rowsOf() as unknown as RedirectRow[];
          for (const row of rows) Object.assign(row, written, { version: row.version + 1 });
          return { data: rows, error: null, count: rows.length };
        }
        if (op === 'delete') {
          const rows = rowsOf() as unknown as RedirectRow[];
          state.redirects = state.redirects.filter((r) => !rows.includes(r));
          return { data: rows.map((r) => ({ id: r.id })), error: null, count: rows.length };
        }
        const rows = rowsOf();
        return { data: head ? null : rows, error: null, count: rows.length };
      };

      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder['select'] = (_c: string, opts?: { head?: boolean }) => {
        head = opts?.head === true;
        return builder;
      };
      for (const m of ['range', 'is', 'neq', 'ilike'] as const) builder[m] = chain;
      // `order` and `limit` are honoured so a read's window is what the test sees.
      builder['order'] = (column: string) => {
        orderBy = column;
        return builder;
      };
      builder['limit'] = (n: number) => {
        limit = n;
        return builder;
      };
      builder['eq'] = (column: string, value: unknown) => {
        filters.push({ op: 'eq', column, value });
        return builder;
      };
      builder['in'] = (column: string, value: unknown) => {
        filters.push({ op: 'in', column, value });
        return builder;
      };
      builder['insert'] = (values: Record<string, unknown>) => {
        op = 'insert';
        written = values;
        return builder;
      };
      builder['update'] = (values: Record<string, unknown>) => {
        op = 'update';
        written = values;
        return builder;
      };
      builder['delete'] = () => {
        op = 'delete';
        return builder;
      };
      builder['single'] = async () => {
        const r = resolve();
        return { data: r.data?.[0] ?? null, error: null };
      };
      builder['maybeSingle'] = async () => {
        const r = resolve();
        return { data: r.data?.[0] ?? null, error: null };
      };
      builder['then'] = (onFulfilled: (value: unknown) => unknown) =>
        Promise.resolve(onFulfilled(resolve()));
      return builder;
    },
  };
}

function ctx(role: Role, method: string, body: unknown, state: Fake, path = `/${ID}`) {
  const url = new URL(`https://admin.example.test/api/admin/redirects${path}`);
  return {
    request: new Request(url, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    }),
    url,
    params: { id: ID },
    locals: {
      session: { userId: ID, tenantId: TENANT, role, isActive: true, email: 'x@example.test' },
      supabase: fakeDb(state),
      cspNonce: 'n',
      csrfToken: 'c',
    },
  } as unknown as Parameters<APIRoute>[0];
}

const call = async (route: APIRoute, c: Parameters<APIRoute>[0]) => {
  const res = (await route(c)) as Response;
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const stored = (overrides: Partial<RedirectRow> = {}): RedirectRow => ({
  id: ID,
  source_path: '/old',
  target_path: '/new',
  status: 301,
  version: 1,
  ...overrides,
});

const { POST } = collectionRoutes(redirectResource);
const { PATCH, DELETE } = itemRoutes(redirectResource);

let state: Fake;

beforeEach(() => {
  state = { redirects: [], live: {} };
  __kv.clear();
  audits.length = 0;
  systemLog.mockClear();
  vi.restoreAllMocks();
});

const edgeMap = () => JSON.parse(__kv.get(REDIRECTS_KV_KEY) ?? 'null') as unknown;

describe('redirectResource — the rules on the merged row', () => {
  it('refuses a reserved source (admin, api, healthz, assets) with 422 on sourcePath', async () => {
    for (const sourcePath of ['/admin/login', '/api/contact', '/healthz', '/_astro/x.js']) {
      const { status, body } = await call(
        POST,
        ctx('admin', 'POST', { sourcePath, targetPath: '/about' }, state),
      );
      expect(status, sourcePath).toBe(422);
      expect(body['field']).toBe('sourcePath');
    }
  });

  it('refuses a self-loop on create, including one hidden by a trailing slash or a query', async () => {
    for (const targetPath of ['/old', '/old/', '/old?x=1', '/old#top']) {
      const { status, body } = await call(
        POST,
        ctx('admin', 'POST', { sourcePath: '/old', targetPath }, state),
      );
      expect(status, targetPath).toBe(422);
      expect(body['field']).toBe('targetPath');
    }
  });

  it('refuses a rule that points at its own /ar twin — the fallback would loop it (finding 2)', async () => {
    const { status, body } = await call(
      POST,
      ctx('admin', 'POST', { sourcePath: '/x', targetPath: '/ar/x' }, state),
    );
    expect(status).toBe(422);
    expect(body['field']).toBe('targetPath');
    expect(String(body['detail'])).toContain('twin');
    expect(state.redirects).toHaveLength(0);
  });

  it('refuses a backslash in a site-relative source or target — `/\host` is `//host` (finding 3)', async () => {
    for (const body of [
      { sourcePath: '/old', targetPath: '/\\evil.test/x' },
      { sourcePath: '/\\evil.test/x', targetPath: '/new' },
      { sourcePath: '/old', targetPath: '/new/\\evil.test' },
    ]) {
      const { status } = await call(POST, ctx('admin', 'POST', body, state));
      expect(status, JSON.stringify(body)).toBe(422);
    }
    expect(state.redirects).toHaveLength(0);
  });

  it('stores an Arabic source in the percent-encoded spelling the request carries (finding 4)', async () => {
    const { status } = await call(
      POST,
      ctx('admin', 'POST', { sourcePath: '/عن', targetPath: '/about' }, state),
    );
    expect(status).toBe(200);
    expect(state.redirects[0]?.source_path).toBe('/%D8%B9%D9%86');
    expect(edgeMap()).toEqual({ '/%D8%B9%D9%86': { to: '/about', status: 301 } });
  });

  it('a PATCH sending only targetPath equal to the STORED source is a loop → 422', async () => {
    state.redirects.push(stored());
    const { status, body } = await call(
      PATCH,
      ctx('admin', 'PATCH', { targetPath: '/old', version: 1 }, state),
    );
    expect(status).toBe(422);
    expect(body['field']).toBe('targetPath');
  });

  it('refuses a chain: pointing at a source that is itself redirected', async () => {
    state.redirects.push(stored({ id: OTHER, source_path: '/mid', target_path: '/final' }));
    const { status, body } = await call(
      POST,
      ctx('admin', 'POST', { sourcePath: '/start', targetPath: '/mid' }, state),
    );
    expect(status).toBe(422);
    expect(body['field']).toBe('targetPath');
    expect(String(body['detail'])).toContain('/final');
  });

  it('refuses a chain: a source that an existing rule already points at', async () => {
    state.redirects.push(stored({ id: OTHER, source_path: '/first', target_path: '/second' }));
    const { status, body } = await call(
      POST,
      ctx('admin', 'POST', { sourcePath: '/second', targetPath: '/third' }, state),
    );
    expect(status).toBe(422);
    expect(body['field']).toBe('sourcePath');
  });

  it('finds the rule that points here behind any number of look-alike rows (finding 9)', async () => {
    // The old prefix read (`LIKE '/old%'`, 50 unordered rows) could miss the exact match
    // among rows targeting `/old-<n>`. The check now reads the tenant's whole set.
    for (let i = 0; i < 60; i += 1) {
      state.redirects.push(
        stored({
          id: `${OTHER.slice(0, -2)}${String(i).padStart(2, '0')}`,
          source_path: `/x${i}`,
          target_path: `/old-${i}`,
        }),
      );
    }
    state.redirects.push(stored({ id: OTHER, source_path: '/y', target_path: '/old?utm=1' }));
    const { status, body } = await call(
      POST,
      ctx('admin', 'POST', { sourcePath: '/old', targetPath: '/new' }, state),
    );
    expect(status).toBe(422);
    expect(body['field']).toBe('sourcePath');
    expect(String(body['detail'])).toContain('/y');
  });

  it('refuses a chain through the /ar twin (finding 8)', async () => {
    // /campaign → /ar/old exists; a new /old rule would make /ar/old hop twice.
    state.redirects.push(stored({ id: OTHER, source_path: '/campaign', target_path: '/ar/old' }));
    const backward = await call(
      POST,
      ctx('admin', 'POST', { sourcePath: '/old', targetPath: '/new' }, state),
    );
    expect(backward.status).toBe(422);
    expect(backward.body['field']).toBe('sourcePath');
    // …and the other way round: a target under /ar whose English rule exists.
    state.redirects = [stored({ id: OTHER, source_path: '/old', target_path: '/new' })];
    const forward = await call(
      POST,
      ctx('admin', 'POST', { sourcePath: '/campaign', targetPath: '/ar/old' }, state),
    );
    expect(forward.status).toBe(422);
    expect(forward.body['field']).toBe('targetPath');
  });

  it('refuses a loop between two rows', async () => {
    state.redirects.push(stored({ id: OTHER, source_path: '/a', target_path: '/b' }));
    const { status, body } = await call(
      POST,
      ctx('admin', 'POST', { sourcePath: '/b', targetPath: '/a' }, state),
    );
    expect(status).toBe(422);
    expect(String(body['detail'])).toContain('loop');
  });

  it('an update does not chain with its own stored row', async () => {
    state.redirects.push(stored({ source_path: '/old', target_path: '/new' }));
    const { status } = await call(
      PATCH,
      ctx('admin', 'PATCH', { targetPath: '/newer', version: 1 }, state),
    );
    expect(status).toBe(200);
  });

  it('refuses a source that renders a page: a static route, in either language', async () => {
    for (const sourcePath of ['/about', '/ar/about', '/portfolio/all', '/', '/services/']) {
      const { status, body } = await call(
        POST,
        ctx('admin', 'POST', { sourcePath, targetPath: '/contact' }, state),
      );
      expect(status, sourcePath).toBe(422);
      expect(body['field']).toBe('sourcePath');
      expect(String(body['detail'])).toContain('renders a page');
    }
  });

  it('refuses a source whose detail slug is live, and allows one that is not', async () => {
    state.live = {
      services: ['logo'],
      portfolio: ['notebook'],
      blog_posts: ['hello'],
      // A `pages` row is a section container, not a route: `/faq` renders nothing even
      // with a published `faq` page row, so it is redirectable (finding 5).
      pages: ['faq'],
    };
    for (const sourcePath of [
      '/services/logo',
      '/ar/services/logo',
      '/portfolio/notebook',
      '/creative-knowledge/hello',
    ]) {
      const { status } = await call(
        POST,
        ctx('admin', 'POST', { sourcePath, targetPath: '/contact' }, state),
      );
      expect(status, sourcePath).toBe(422);
    }
    state.redirects = [];
    for (const sourcePath of ['/services/branding', '/portfolio/gone', '/old-page', '/faq']) {
      state.redirects = [];
      const { status } = await call(
        POST,
        ctx('admin', 'POST', { sourcePath, targetPath: '/contact' }, state),
      );
      expect(status, sourcePath).toBe(200);
    }
  });

  it('a status-only PATCH re-runs no rule (no reads, no live check)', async () => {
    // The stored row's source is now live: an editor flipping 301 → 308 must still save.
    state.redirects.push(stored({ source_path: '/services/logo' }));
    state.live = { services: ['logo'] };
    const { status } = await call(PATCH, ctx('admin', 'PATCH', { status: 308, version: 1 }, state));
    expect(status).toBe(200);
  });

  it('normalises the source and refuses an unsupported target scheme', async () => {
    const created = await call(
      POST,
      ctx('admin', 'POST', { sourcePath: '/trailing/', targetPath: '/x' }, state),
    );
    expect(created.status).toBe(200);
    expect(state.redirects[0]?.source_path).toBe('/trailing');
    // The schema refuses javascript: before toRow does; both layers say 422.
    const bad = await call(
      POST,
      ctx('admin', 'POST', { sourcePath: '/js', targetPath: 'javascript:alert(1)' }, state),
    );
    expect(bad.status).toBe(422);
  });
});

describe('redirectResource — the edge snapshot', () => {
  it('create writes the tenant map to KV and reports kvSynced:true with the count', async () => {
    const { status, body } = await call(
      POST,
      ctx('seo', 'POST', { sourcePath: '/old', targetPath: '/new', status: 302 }, state),
    );
    expect(status).toBe(200);
    expect(body['data']).toMatchObject({ kvSynced: true, count: 1, truncated: false });
    expect(edgeMap()).toEqual({ '/old': { to: '/new', status: 302 } });
    // …and the audit row carries the same outcome, and names the rule (finding 7).
    expect(audits[0]).toMatchObject({
      action: 'redirect.create',
      detail: expect.objectContaining({
        kvSynced: true,
        count: 1,
        source_path: '/old',
        target_path: '/new',
        status: 302,
      }),
    });
  });

  it('an update is audited with the rule as it now is (finding 7)', async () => {
    state.redirects.push(stored());
    const { status } = await call(
      PATCH,
      ctx('admin', 'PATCH', { targetPath: '/newer', version: 1 }, state),
    );
    expect(status).toBe(200);
    expect(audits[0]).toMatchObject({
      action: 'redirect.update',
      detail: expect.objectContaining({
        fields: ['target_path'],
        source_path: '/old',
        target_path: '/newer',
        kvSynced: true,
      }),
    });
  });

  it('a KV failure is a 200 with kvSynced:false — the row is saved, the editor is told', async () => {
    vi.spyOn(stubEnv.SESSION, 'put').mockRejectedValue(new Error('kv down'));
    const { status, body } = await call(
      POST,
      ctx('admin', 'POST', { sourcePath: '/old', targetPath: '/new' }, state),
    );
    expect(status).toBe(200);
    expect(body['data']).toMatchObject({ kvSynced: false });
    expect(state.redirects).toHaveLength(1);
    expect(audits[0]).toMatchObject({ detail: expect.objectContaining({ kvSynced: false }) });
  });

  it('DELETE rebuilds the map without the row, and SEO may delete', async () => {
    state.redirects.push(stored(), stored({ id: OTHER, source_path: '/keep', target_path: '/k' }));
    const { status, body } = await call(DELETE, ctx('seo', 'DELETE', undefined, state));
    expect(status).toBe(200);
    expect(body['data']).toMatchObject({ deleted: ID, kvSynced: true, count: 1 });
    expect(edgeMap()).toEqual({ '/keep': { to: '/k', status: 301 } });
    // The audit row names the rule that went, not only its id (finding 7).
    expect(audits[0]).toMatchObject({
      action: 'redirect.delete',
      entityId: ID,
      detail: expect.objectContaining({ source_path: '/old', target_path: '/new', status: 301 }),
    });
  });

  it('Content Creator and Developer cannot delete a redirect', async () => {
    state.redirects.push(stored());
    for (const role of ['content_creator', 'developer'] as const) {
      expect((await call(DELETE, ctx(role, 'DELETE', undefined, state))).status, role).toBe(403);
    }
    expect(state.redirects).toHaveLength(1);
  });
});

describe('POST /api/admin/redirects/sync', () => {
  it('rebuilds the snapshot from the table and is audited as redirect.sync', async () => {
    const { POST: SYNC } = await import('@/pages/api/admin/redirects/sync');
    state.redirects.push(
      stored({ source_path: '/one', target_path: '/1' }),
      stored({ id: OTHER, source_path: '/admin/x', target_path: '/dropped' }),
    );
    const { status, body } = await call(SYNC, ctx('seo', 'POST', undefined, state, '/sync'));
    expect(status).toBe(200);
    expect(body['data']).toEqual({ kvSynced: true, count: 1, truncated: false });
    expect(edgeMap()).toEqual({ '/one': { to: '/1', status: 301 } });
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'redirect.sync',
        detail: { kvSynced: true, count: 1, truncated: false },
      }),
    ]);
  });

  it('GET reports the database count beside the edge count (null before a first sync)', async () => {
    const { GET } = await import('@/pages/api/admin/redirects/sync');
    state.redirects.push(stored());
    const before = await call(GET, ctx('admin', 'GET', undefined, state, '/sync'));
    expect(before.body['data']).toEqual({ db: 1, edge: null });
    __kv.set(REDIRECTS_KV_KEY, JSON.stringify({ '/a': { to: '/b', status: 301 } }));
    const after = await call(GET, ctx('admin', 'GET', undefined, state, '/sync'));
    expect(after.body['data']).toEqual({ db: 1, edge: 1 });
  });

  it('a failing read is kvSynced:false and a system log, never a 500', async () => {
    const { POST: SYNC } = await import('@/pages/api/admin/redirects/sync');
    const broken = ctx('admin', 'POST', undefined, state, '/sync');
    (broken.locals as { supabase: unknown }).supabase = {
      from: () => {
        throw new Error('db down');
      },
    };
    const { status, body } = await call(SYNC, broken);
    expect(status).toBe(200);
    expect(body['data']).toEqual({ kvSynced: false, count: 0, truncated: false });
    expect(systemLog).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'admin:redirect.sync' }),
    );
  });
});
