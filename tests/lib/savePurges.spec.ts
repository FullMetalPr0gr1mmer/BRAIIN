import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIContext, APIRoute } from 'astro';

// The purges after IMMEDIATE saves (Admin v2 R7; releases.md §1.2, §5.3): a media row's edit
// (the kernel PATCH and the SEO role's meta route) purges `media:all` when it moves a column
// a public page renders (alt, the file...), never for tags, folder or the name alone; a page's
// visibility, its password and the legacy "show in menu" switch purge the page, the menus, the
// sitemap and llms.txt (`visibilityPurgeTags`), the same tags they answer. Each after the commit, through
// the one seam, which sends nothing while no zone is set up (tests/lib/purge.spec.ts). A media
// row that is only created purges nothing (no page shows it yet), and the answers are as before.

const state = vi.hoisted(() => ({
  purges: [] as { tenant: string; tags: string[]; source: string }[],
  audits: [] as { action: string }[],
  /** A cache zone set up (purgeConfig), or not (O-3). */
  zone: null as { zoneId: string; token: string } | null,
  /** The meta route's read of the alt before its write: its answer, and the reads made. */
  altBefore: null as Record<string, unknown> | null | 'error',
  reads: [] as string[],
}));

vi.mock('@/lib/http/purge', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  purgeConfig: () => state.zone,
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
        from: (table: string) => {
          const chain = {
            select: (columns: string) => {
              state.reads.push(`${table}:${columns}`);
              return chain;
            },
            eq: () => chain,
            maybeSingle: async () =>
              state.altBefore === 'error'
                ? { data: null, error: { message: 'down' } }
                : { data: state.altBefore, error: null },
          };
          return chain;
        },
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
  state.zone = null;
  state.altBefore = null;
  state.reads = [];
});

const ZONE = { zoneId: '0123456789abcdef0123456789abcdef', token: 't' };
/** A media row as the kernel reads it (its `columns`). */
const MEDIA_ROW = {
  id: ASSET,
  kind: 'image',
  provider: 'storage',
  storage_path: 'tenant/a.webp',
  display_name: 'a.webp',
  folder: 'Brand',
  alt: { en: 'A logo', ar: 'شعار' },
  tags: ['logo'],
  width: 800,
  height: 600,
  mime_type: 'image/webp',
  size_bytes: 1000,
  stream_uid: null,
  version: 4,
};
const MEDIA_PURGE = { tenant: TENANT, tags: ['media:all'], source: 'media' };

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
    // No zone: nothing read before the write, as before R7.
    expect(state.reads).toEqual([]);
  });

  it('a kernel edit purges only when a column a public page renders moved', async () => {
    const hook = mediaResource.afterWrite!;
    const run = (after: Record<string, unknown>) =>
      hook({
        auth: { tenantId: TENANT },
        sb: {},
        row: after,
        input: {},
        operation: 'update',
        before: MEDIA_ROW,
      } as never);
    // Tags, folder and the name are the library's own.
    await run({ ...MEDIA_ROW, tags: ['logo', 'brand'], folder: 'Old', display_name: 'b.webp' });
    expect(state.purges).toEqual([]);
    // The alt (the same words in another key order is no change), the file, the size.
    await run({ ...MEDIA_ROW, alt: { ar: 'شعار', en: 'A logo' } });
    expect(state.purges).toEqual([]);
    await run({ ...MEDIA_ROW, alt: { en: 'The logo', ar: 'شعار' } });
    await run({ ...MEDIA_ROW, storage_path: 'tenant/b.webp' });
    await run({ ...MEDIA_ROW, width: 1600 });
    expect(state.purges).toEqual([MEDIA_PURGE, MEDIA_PURGE, MEDIA_PURGE]);
  });

  it('the meta route: tags or folder alone purge nothing and read nothing', async () => {
    state.zone = ZONE;
    const res = await call(
      META,
      ctx('PATCH', { tags: ['logo'], folder: 'Brand', version: 4 }, { id: ASSET }, 'seo'),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(state.purges).toEqual([]);
    expect(state.reads).toEqual([]);
    expect(state.audits.map((a) => a.action)).toEqual(['media_asset.update_meta']);
  });

  it('the meta route with a zone: the same alt purges nothing, a new one purges, an unread one purges', async () => {
    state.zone = ZONE;
    const body = { alt: { en: 'A', ar: 'ب' }, tags: ['x'], folder: null, version: 4 };
    state.altBefore = { alt: { ar: 'ب', en: 'A' } };
    expect((await call(META, ctx('PATCH', body, { id: ASSET }, 'seo'))).status).toBe(200);
    expect(state.reads).toEqual(['media_assets:alt']);
    expect(state.purges).toEqual([]);

    state.altBefore = { alt: { en: 'Old', ar: 'ب' } };
    expect((await call(META, ctx('PATCH', body, { id: ASSET }, 'seo'))).status).toBe(200);
    expect(state.purges).toEqual([MEDIA_PURGE]);

    state.altBefore = 'error';
    expect((await call(META, ctx('PATCH', body, { id: ASSET }, 'seo'))).status).toBe(200);
    expect(state.purges).toEqual([MEDIA_PURGE, MEDIA_PURGE]);
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
