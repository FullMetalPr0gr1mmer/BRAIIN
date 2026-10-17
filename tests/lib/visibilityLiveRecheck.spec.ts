import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { VISIBILITY_KV_KEY, clearVisibilityMemo } from '@/lib/http/visibility';
import { __kv } from '../stubs/cloudflare-workers';

// The §9 (b) regression for page visibility (Admin v2 U14a): a Developer demoted, switched
// off or locked under an open session is refused (403) by the screen's save, PUT
// /api/admin/page-visibility, and by the legacy alias, PATCH /api/admin/pages/visibility/[id],
// before anything is read or written: no row, no KV snapshot, no audit row. The real
// liveRecheck runs; only its service-role read of the caller's profile is stubbed. RLS refuses
// the same token in the database (page_visibility.test.sql); this is the Worker's layer.

interface Read {
  data: unknown;
  error: unknown;
}

const { state } = vi.hoisted(() => ({
  state: {
    /** What liveRecheck's service-role read of the caller's profile finds. */
    live: { data: null, error: null } as Read,
    audits: [] as unknown[],
  },
}));

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      b['select'] = () => b;
      b['eq'] = () => b;
      b['maybeSingle'] = async () =>
        table === 'profiles' ? state.live : { data: null, error: null };
      return b;
    },
  }),
}));
vi.mock('@/lib/admin/audit', () => ({
  writeAudit: async (_sb: unknown, _ctx: unknown, entry: unknown) => {
    state.audits.push(entry);
    return true;
  },
}));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

const screen = await import('@/pages/api/admin/page-visibility/index');
const alias = await import('@/pages/api/admin/pages/visibility/[id]');

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVELOPER = '11111111-1111-4111-8111-111111111111';
const ABOUT = '22222222-2222-4222-8222-222222222222';

/** The Developer's session client: every table it is asked for is recorded, and empty. */
function session() {
  const tables: string[] = [];
  const client = {
    tables,
    from(table: string) {
      tables.push(table);
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'neq', 'match', 'order', 'limit', 'insert', 'update']) {
        b[m] = () => b;
      }
      b['maybeSingle'] = async () => ({ data: null, error: null });
      b['single'] = async () => ({ data: null, error: null });
      b['then'] = (ok: (v: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null, count: 0 }).then(ok);
      return b;
    },
  };
  return client;
}

function call(
  route: APIRoute,
  method: 'PUT' | 'PATCH',
  path: string,
  sb: ReturnType<typeof session>,
  body: unknown,
  params: Record<string, string> = {},
) {
  const url = new URL(`https://admin.example.test${path}`);
  return route({
    request: new Request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    url,
    params,
    locals: {
      session: {
        userId: DEVELOPER,
        tenantId: TENANT,
        role: 'developer',
        isActive: true,
        email: 'd@x.test',
      },
      supabase: sb,
      cspNonce: 'n',
      csrfToken: 'c',
    },
  } as unknown as Parameters<APIRoute>[0]) as Promise<Response>;
}

const save = (sb: ReturnType<typeof session>) =>
  call(screen.PUT as APIRoute, 'PUT', '/api/admin/page-visibility', sb, {
    target: { pageId: ABOUT },
    mode: 'hidden',
    redirectPageId: null,
    hideFrom: null,
    showOn: null,
    version: 0,
  });

const toggle = (sb: ReturnType<typeof session>) =>
  call(
    alias.PATCH as APIRoute,
    'PATCH',
    `/api/admin/pages/visibility/${ABOUT}`,
    sb,
    { navVisible: false, version: 0 },
    { id: ABOUT },
  );

const live = (profile: Record<string, unknown> | null): Read => ({ data: profile, error: null });

const STALE: [string, Read][] = [
  ['demoted to SEO', live({ role: 'seo', is_active: true, locked_until: null })],
  ['switched off', live({ role: 'developer', is_active: false, locked_until: null })],
  [
    'locked',
    live({
      role: 'developer',
      is_active: true,
      locked_until: new Date(Date.now() + 10 * 60_000).toISOString(),
    }),
  ],
  ['gone (no profile)', live(null)],
  ['unreadable (the profile read fails)', { data: null, error: { message: 'down' } }],
];

beforeEach(() => {
  state.live = live({ role: 'developer', is_active: true, locked_until: null });
  state.audits = [];
  __kv.clear();
  clearVisibilityMemo();
});

describe.each([
  ['PUT /api/admin/page-visibility', save],
  ['PATCH /api/admin/pages/visibility/[id] (the alias)', toggle],
])('%s re-reads the person before it writes', (_name, run) => {
  it.each(STALE)(
    'a Developer %s gets a 403, and nothing is read, written or synced',
    async (_label, read) => {
      state.live = read;
      const sb = session();
      const res = await run(sb);
      expect(res.status).toBe(403);
      expect(sb.tables).toEqual([]);
      expect(__kv.has(VISIBILITY_KV_KEY)).toBe(false);
      expect(state.audits).toEqual([]);
    },
  );

  it('a live Developer passes the recheck and reaches the save (here: no such page, 404)', async () => {
    const sb = session();
    const res = await run(sb);
    expect(res.status).toBe(404);
    expect(sb.tables).toContain('pages');
  });
});
