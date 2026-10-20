import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';

// A share image is a composite foreign key to the tenant's own media (0073): an id that names
// another tenant's picture, or one hard-deleted since the picker listed it, is refused by the
// database with 23503. That is the editor's input, not a server fault: both SEO saves answer
// a 422 on the field (U10 review), and nothing is written to system_logs as an error. Driven
// through the real routes with releases off, on the first save (an INSERT) and on an edit.

const { systemLog } = vi.hoisted(() => ({ systemLog: vi.fn(async () => true) }));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: systemLog }));

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';
const ASSET = '73000000-0000-4000-8000-0000000000ff';
const TARGET = '22222222-2222-4222-8222-222222222222';

interface DbError {
  code: string;
  message: string;
  details: string | null;
}

const fkError = (table: string, constraint: string, column: string): DbError => ({
  code: '23503',
  message: `insert or update on table "${table}" violates foreign key constraint "${constraint}"`,
  details: `Key (tenant_id, ${column})=(${TENANT}, ${ASSET}) is not present in table "media_assets".`,
});

/**
 * One tenant, releases off. `existing` is the stored row (null: none yet); the write
 * (insert or update) answers `error`.
 */
function client(existing: Record<string, unknown> | null, error: DbError) {
  return {
    rpc: async (fn: string) =>
      fn === 'releases_enabled'
        ? { data: false, error: null }
        : { data: null, error: { message: `unexpected ${fn}` } },
    from: () => {
      let wrote = false;
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'limit']) b[m] = () => b;
      b['insert'] = () => {
        wrote = true;
        return b;
      };
      b['update'] = () => {
        wrote = true;
        return b;
      };
      b['maybeSingle'] = async () =>
        wrote ? { data: null, error } : { data: existing, error: null };
      b['single'] = async () => (wrote ? { data: null, error } : { data: existing, error: null });
      return b;
    },
  };
}

function call(method: 'PATCH' | 'PUT', url: string, body: unknown, sb: unknown) {
  const full = new URL(url, 'https://admin.example.test');
  return {
    request: new Request(full, {
      method,
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    url: full,
    params: {},
    locals: {
      session: { userId: USER, tenantId: TENANT, role: 'seo', isActive: true, email: 's@x.test' },
      supabase: sb,
      cspNonce: 'test',
      csrfToken: 'test',
    },
  } as unknown as Parameters<APIRoute>[0];
}

const ROUTES: {
  name: string;
  method: 'PATCH' | 'PUT';
  url: string;
  body: Record<string, unknown>;
  stored: Record<string, unknown>;
  error: DbError;
  field: string;
  load: () => Promise<Record<string, unknown>>;
}[] = [
  {
    name: 'entity SEO',
    method: 'PUT',
    url: '/api/admin/entity-seo',
    body: { entityType: 'service', entityId: TARGET, ogMediaId: ASSET },
    stored: { id: '33333333-3333-4333-8333-333333333333', version: 3 },
    error: fkError('entity_seo', 'entity_seo_og_media_fk', 'og_media_id'),
    field: 'ogMediaId',
    load: () => import('@/pages/api/admin/entity-seo'),
  },
  {
    name: 'SEO defaults',
    method: 'PATCH',
    url: '/api/admin/seo-defaults',
    body: { defaultOgMediaId: ASSET },
    stored: { version: 3 },
    error: fkError('seo_defaults', 'seo_defaults_default_og_media_fk', 'default_og_media_id'),
    field: 'defaultOgMediaId',
    load: () => import('@/pages/api/admin/seo-defaults'),
  },
];

// The routes' first import is slow on a cold cache; it is not what the tests time.
beforeAll(async () => {
  await Promise.all(ROUTES.map((route) => route.load()));
}, 60_000);

beforeEach(() => {
  systemLog.mockClear();
});

describe('a share image the database refuses (23503) is a 422 on its field', () => {
  for (const route of ROUTES) {
    for (const [when, stored, version] of [
      ['the first save', null, 0],
      ['an edit', route.stored, 3],
    ] as const) {
      it(`${route.name}: ${when}`, async () => {
        const handler = (await route.load())[route.method] as APIRoute;
        const res = (await handler(
          call(route.method, route.url, { ...route.body, version }, client(stored, route.error)),
        )) as Response;
        expect(res.status, await res.clone().text()).toBe(422);
        expect(await res.json()).toMatchObject({
          ok: false,
          error: 'validation',
          detail: 'Choose a picture from the media library',
          field: route.field,
        });
        expect(systemLog).not.toHaveBeenCalled();
      });
    }
  }

  it('entity SEO: a foreign key it does not name is still a server error', async () => {
    const { PUT } = (await import('@/pages/api/admin/entity-seo')) as { PUT: APIRoute };
    const other = fkError('entity_seo', 'entity_seo_tenant_fk', 'tenant_id');
    const res = (await PUT(
      call(
        'PUT',
        '/api/admin/entity-seo',
        { entityType: 'service', entityId: TARGET, ogMediaId: ASSET, version: 3 },
        client({ id: '33333333-3333-4333-8333-333333333333', version: 3 }, other),
      ),
    )) as Response;
    expect(res.status).toBe(500);
  });

  it('SEO defaults: a foreign key it does not name is still a server error', async () => {
    const { PATCH } = (await import('@/pages/api/admin/seo-defaults')) as { PATCH: APIRoute };
    const other = fkError('seo_defaults', 'seo_defaults_tenant_fk', 'tenant_id');
    const res = (await PATCH(
      call(
        'PATCH',
        '/api/admin/seo-defaults',
        { defaultOgMediaId: ASSET, version: 3 },
        client({ version: 3 }, other),
      ),
    )) as Response;
    expect(res.status).toBe(500);
  });
});
