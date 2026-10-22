import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIContext, APIRoute } from 'astro';

// The purges after IMMEDIATE saves (Admin v2 R7; releases.md §1.2, §5.3): a media row's edit
// (the kernel PATCH and the SEO role's meta route) purges `media:all`; a page's visibility,
// its password and the legacy "show in menu" switch purge the page, the menus, the sitemap and
// llms.txt (`visibilityPurgeTags`), the same tags they answer. Each after the commit, through
// the one seam, which sends nothing while no zone is set up (tests/lib/purge.spec.ts). A media
// row that is only created purges nothing (no page shows it yet), and the answers are as before.

const state = vi.hoisted(() => ({
  purges: [] as { tenant: string; tags: string[]; source: string }[],
  audits: [] as { action: string }[],
}));

vi.mock('@/lib/http/purge', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  purgeAfterSave: async (tenant: string, tags: readonly string[], source: string) => {
    state.purges.push({ tenant, tags: [...tags], source });
    return { status: 'skipped', tags: [...tags], requests: 0, reason: 'not-set-up' };
  },
}));
vi.mock('@/lib/admin/audit', () => ({
  writeAudit: async (_sb: unknown, _ctx: unknown, entry: { action: string }) => {
    state.audits.push(entry);
    return true;
  },
}));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
vi.mock('@/lib/admin/liveRecheck', () => ({ liveRecheck: async () => undefined }));
vi.mock('@/lib/admin/visibilitySync', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  syncVisibilityToEdge: async () => ({ kvSynced: true, count: 1 }),
}));
vi.mock('@/lib/admin/pageVisibility', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  saveVisibility: async () => ({
    row: { id: 'v1', mode: 'hidden', version: 2 },
    fields: ['mode'],
    target: { kind: 'page', slug: 'about', id: PAGE },
  }),
  savePagePassword: async () => ({ setting: { mode: 'password' }, slug: 'join', pageId: PAGE }),
  settingOfRow: () => ({ mode: 'hidden' }),
}));

const PAGE = '22222222-2222-4222-8222-222222222222';
const ASSET = '33333333-3333-4333-8333-333333333333';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const { mediaResource } = await import('@/lib/admin/resources/media');
const { PATCH: META } = await import('@/pages/api/admin/media/meta/[id]');
const { PUT: VISIBILITY } = await import('@/pages/api/admin/page-visibility/index');
const { POST: PASSWORD } = await import('@/pages/api/admin/page-visibility/password');
const { PATCH: NAV_VISIBLE } = await import('@/pages/api/admin/pages/visibility/[id]');
const { visibilityPurgeTags } = await import('@/lib/admin/visibilitySync');

function ctx(method: string, body: unknown, params: Record<string, string>, role = 'admin') {
  const url = new URL('https://admin.example.test/api/admin/x');
  return {
    request: new Request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    url,
    params,
    locals: {
      session: { userId: 'u1', tenantId: TENANT, role, isActive: true, email: 'a@example.test' },
      supabase: {
        rpc: async (fn: string) =>
          fn === 'update_media_meta'
            ? { data: [{ id: ASSET, version: 5, alt: { en: 'A', ar: 'ب' } }], error: null }
            : { data: null, error: null },
      },
      cspNonce: 'n',
      csrfToken: 'c',
    },
  } as unknown as APIContext;
}
async function call(route: APIRoute, context: APIContext) {
  const res = (await route(context)) as Response;
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

beforeEach(() => {
  state.purges = [];
  state.audits = [];
});

describe('media', () => {
  it('an edit of a row purges media:all; a new row purges nothing; the hook adds nothing to the answer', async () => {
    const hook = mediaResource.afterWrite!;
    const args = { auth: { tenantId: TENANT }, sb: {}, row: {}, input: {} } as never;
    expect(await hook({ ...(args as object), operation: 'update' } as never)).toBeUndefined();
    expect(state.purges).toEqual([{ tenant: TENANT, tags: ['media:all'], source: 'media' }]);
    await hook({ ...(args as object), operation: 'create' } as never);
    expect(state.purges).toHaveLength(1);
  });

  it('the SEO role’s alt and tags save purges media:all after the write, then audits', async () => {
    const res = await call(
      META,
      ctx('PATCH', { alt: { en: 'A', ar: 'ب' }, version: 4 }, { id: ASSET }, 'seo'),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(state.purges).toEqual([{ tenant: TENANT, tags: ['media:all'], source: 'media' }]);
    expect(state.audits.map((a) => a.action)).toEqual(['media_asset.update_meta']);
  });
});

describe('page visibility', () => {
  it('a page’s setting purges what it answers: the page, the menus, the sitemap, llms.txt', async () => {
    const res = await call(
      VISIBILITY,
      ctx('PUT', { target: { pageId: PAGE }, mode: 'hidden', version: 1 }, {}, 'developer'),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const tags = visibilityPurgeTags({ kind: 'page', slug: 'about' });
    expect(state.purges).toEqual([{ tenant: TENANT, tags, source: 'visibility' }]);
    expect(res.body['data']['purgeTags']).toEqual(tags);
  });

  it('a password set on a page purges its cached copies', async () => {
    const res = await call(
      PASSWORD,
      ctx('POST', { pageId: PAGE, password: 'correct horse', version: 0 }, {}, 'developer'),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(state.purges).toEqual([
      {
        tenant: TENANT,
        tags: visibilityPurgeTags({ kind: 'page', slug: 'join' }),
        source: 'visibility',
      },
    ]);
  });

  it('the legacy "show in menu" switch purges the same', async () => {
    const res = await call(
      NAV_VISIBLE,
      ctx('PATCH', { navVisible: false, version: 1 }, { id: PAGE }, 'developer'),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const tags = visibilityPurgeTags({ kind: 'page', slug: 'about' });
    expect(state.purges).toEqual([{ tenant: TENANT, tags, source: 'visibility' }]);
    expect(res.body['data']['purgeTags']).toEqual(tags);
  });
});
