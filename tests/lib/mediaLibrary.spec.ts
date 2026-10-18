import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIContext, APIRoute } from 'astro';
import {
  encodeMediaMeta,
  MEDIA_LIBRARY_PAGE_SIZE,
  MEDIA_META_HEADER,
  MediaLibraryQuerySchema,
} from '@schemas/media';
import { MediaMetaOnlySchema } from '@schemas/admin';
import { ROLES } from '@/lib/auth/types';
import { ROLE_CAPS } from '@/lib/authz/matrix';

// The media library's reads (Admin v2 U4): GET /api/admin/media/library over
// `public.media_library` (0064), and the stats route's two flags. What these hold:
//   • the query's bounds, before the database sees it (the function holds them again);
//   • the route names the SESSION's tenant and passes the clamped values; a 22023 is a 422;
//   • rows come back through the media resource's fromRow (thumb_url, preview_url);
//   • every role that reads the library may call it; uploadsReady and canUpload follow the
//     one test the upload route makes (uploadsConfigured), so stubbing the binding away flips
//     the stats flag AND the upload route's "Not set up" together;
//   • the drawer's save door (MediaMetaOnlySchema) takes what an upload takes and no more.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';
const KEY = `${TENANT}/7e3f9c2a-1b4d-4e8f-9a6b-5c3d2e1f0a9b_2560x1707.webp`;

const state = vi.hoisted(() => ({
  binding: true,
  configured: true,
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  libraryAnswer: null as unknown,
  libraryError: null as null | { code: string; message: string },
}));

vi.mock('cloudflare:workers', () => ({
  env: {
    get IMAGES() {
      return state.binding ? { input: () => ({}) } : undefined;
    },
  },
}));
vi.mock('@/lib/supabase/client', () => ({ supabaseConfigured: () => state.configured }));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
vi.mock('@/lib/admin/liveRecheck', () => ({ liveRecheck: async () => undefined }));

function client() {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      if (fn === 'media_library') {
        return state.libraryError
          ? { data: null, error: state.libraryError }
          : { data: state.libraryAnswer, error: null };
      }
      if (fn === 'media_storage_stats') return { data: [{ assets: 2, bytes: 900 }], error: null };
      return { data: null, error: null };
    },
    from: () => {
      throw new Error('the library reads through its RPC only');
    },
  };
}

function ctx(url: string, role = 'admin', init: RequestInit = {}): APIContext {
  const request = new Request(`https://admin.example.test${url}`, init);
  return {
    request,
    url: new URL(request.url),
    params: {},
    locals: {
      session: { userId: USER, tenantId: TENANT, role, isActive: true, email: 'x@example.test' },
      supabase: client(),
      cspNonce: 'test',
      csrfToken: 'test',
    },
  } as unknown as APIContext;
}

async function call(route: APIRoute, context: APIContext) {
  const res = (await route(context)) as Response;
  const body = (await res.json()) as Record<string, any>;
  return { status: res.status, body };
}

const { GET: LIBRARY } = await import('@/pages/api/admin/media/library');
const { GET: STATS } = await import('@/pages/api/admin/media/stats');
const { POST: UPLOAD } = await import('@/pages/api/admin/media/upload');
const { uploadsConfigured } = await import('@/lib/admin/mediaUpload');

beforeEach(() => {
  state.binding = true;
  state.configured = true;
  state.rpcCalls = [];
  state.libraryAnswer = { total: 0, rows: [] };
  state.libraryError = null;
});

describe('the query (MediaLibraryQuerySchema)', () => {
  it('defaults to the first page of 48 images', () => {
    expect(MEDIA_LIBRARY_PAGE_SIZE).toBe(48);
    expect(MediaLibraryQuerySchema.parse({})).toEqual({ tab: 'image', limit: 48, offset: 0 });
  });

  it('bounds the search as 0064 does: 64 characters, no control character', () => {
    expect(MediaLibraryQuerySchema.safeParse({ q: 'a'.repeat(64) }).success).toBe(true);
    expect(MediaLibraryQuerySchema.safeParse({ q: 'a'.repeat(65) }).success).toBe(false);
    for (const c of ['\u0000', '\u0007', '\u001f', '\u007f', '\u0085', '\u009f']) {
      expect(MediaLibraryQuerySchema.safeParse({ q: `x${c}y` }).success, c).toBe(false);
    }
    expect(MediaLibraryQuerySchema.safeParse({ q: 'صورة الإطار 50%_off' }).success).toBe(true);
  });

  it('bounds the page: 1 to 100 rows, an offset of 0 to 10,000', () => {
    for (const [limit, ok] of [
      ['1', true],
      ['100', true],
      ['0', false],
      ['101', false],
      ['2.5', false],
    ] as const) {
      expect(MediaLibraryQuerySchema.safeParse({ limit }).success, limit).toBe(ok);
    }
    for (const [offset, ok] of [
      ['0', true],
      ['10000', true],
      ['-1', false],
      ['10001', false],
    ] as const) {
      expect(MediaLibraryQuerySchema.safeParse({ offset }).success, offset).toBe(ok);
    }
  });

  it('lists images only, and filters on missing alt text only', () => {
    expect(MediaLibraryQuerySchema.safeParse({ tab: 'video' }).success).toBe(false);
    expect(MediaLibraryQuerySchema.safeParse({ alt: 'missing' }).success).toBe(true);
    expect(MediaLibraryQuerySchema.safeParse({ alt: 'present' }).success).toBe(false);
  });
});

describe('GET /api/admin/media/library', () => {
  it('names the session tenant and passes the bounded values to media_library', async () => {
    const { status } = await call(
      LIBRARY,
      ctx('/api/admin/media/library?q=dunes&alt=missing&limit=12&offset=24&tenant=other'),
    );
    expect(status).toBe(200);
    expect(state.rpcCalls).toEqual([
      {
        fn: 'media_library',
        args: {
          p_tenant: TENANT,
          p_q: 'dunes',
          p_kind: 'image',
          p_needs_alt: true,
          p_limit: 12,
          p_offset: 24,
        },
      },
    ]);
  });

  it('without a search or the filter: no query, needs-alt false, page 1 of 48', async () => {
    await call(LIBRARY, ctx('/api/admin/media/library'));
    expect(state.rpcCalls[0]?.args).toMatchObject({
      p_q: null,
      p_needs_alt: false,
      p_limit: 48,
      p_offset: 0,
    });
  });

  it('refuses an out-of-range query before the database (422)', async () => {
    const { status } = await call(LIBRARY, ctx(`/api/admin/media/library?q=${'a'.repeat(65)}`));
    expect(status).toBe(422);
    expect(state.rpcCalls).toEqual([]);
  });

  it('turns the function’s 22023 into a 422, and any other error into a 500', async () => {
    state.libraryError = { code: '22023', message: 'media_library: a page is 1 to 100 rows' };
    expect((await call(LIBRARY, ctx('/api/admin/media/library'))).status).toBe(422);
    state.libraryError = { code: '57014', message: 'canceling statement due to statement timeout' };
    expect((await call(LIBRARY, ctx('/api/admin/media/library'))).status).toBe(500);
  });

  it('shapes rows through the media resource: a thumbnail and a 640 px preview', async () => {
    state.libraryAnswer = {
      total: 3,
      rows: [
        {
          id: 'u',
          provider: 'storage',
          storage_path: KEY,
          kind: 'image',
          width: 2560,
          height: 1707,
        },
        { id: 's', provider: 'static', storage_path: 'stills/nope.jpg', kind: 'image' },
        { id: 'e', provider: 'external', storage_path: 'https://x.example.test/a.jpg' },
      ],
    };
    const { body } = await call(LIBRARY, ctx('/api/admin/media/library'));
    const [upload, still, external] = body['data'].rows as Record<string, string | null>[];
    expect(body['data'].total).toBe(3);
    const thumb = new URL(upload!['thumb_url']!, 'https://x.test').searchParams;
    const preview = new URL(upload!['preview_url']!, 'https://x.test').searchParams;
    expect([thumb.get('w'), thumb.get('h')]).toEqual(['320', '213']);
    expect([preview.get('w'), preview.get('h')]).toEqual(['640', '427']);
    // An unknown still renders nothing; an external row has no thumbnail either.
    expect([still!['thumb_url'], still!['preview_url']]).toEqual([null, null]);
    expect([external!['thumb_url'], external!['preview_url']]).toEqual([null, null]);
  });

  it('answers an empty page when the function answers nothing', async () => {
    state.libraryAnswer = null;
    const { body } = await call(LIBRARY, ctx('/api/admin/media/library'));
    expect(body['data']).toEqual({ total: 0, rows: [] });
  });

  it('is open to every role that reads the library, and only to them', async () => {
    for (const role of ROLES) {
      const reads = ['full', 'meta'].includes(ROLE_CAPS[role]['media.write']);
      const { status } = await call(LIBRARY, ctx('/api/admin/media/library', role));
      expect(status, role).toBe(reads ? 200 : 403);
    }
  });
});

describe('Upload is offered exactly where the upload route would take it', () => {
  it('stats: uploadsReady and canUpload, by role', async () => {
    for (const role of ROLES) {
      const { body } = await call(STATS, ctx('/api/admin/media/stats', role));
      expect(body['data'], role).toMatchObject({
        assets: 2,
        bytes: 900,
        uploadsReady: true,
        canUpload: ROLE_CAPS[role]['media.write'] === 'full',
      });
    }
  });

  it('one test decides both: without the Images binding, or without Supabase', async () => {
    for (const off of ['binding', 'configured'] as const) {
      state.binding = true;
      state.configured = true;
      state[off] = false;
      expect(uploadsConfigured(), off).toBe(false);
      const { body } = await call(STATS, ctx('/api/admin/media/stats'));
      expect(body['data'], off).toMatchObject({ uploadsReady: false, canUpload: false });
      const file = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const upload = await call(
        UPLOAD,
        ctx('/api/admin/media/upload', 'admin', {
          method: 'POST',
          body: file,
          headers: {
            'content-length': String(file.length),
            [MEDIA_META_HEADER]: encodeMediaMeta({ alt: { en: 'A', ar: 'ب' } }),
          },
        }),
      );
      expect([upload.status, upload.body['error']], off).toEqual([503, 'not-set-up']);
    }
    state.binding = true;
    state.configured = true;
    expect(uploadsConfigured()).toBe(true);
  });
});

describe('the drawer saves what an upload takes (MediaMetaOnlySchema, D6)', () => {
  const ok = (body: unknown) => MediaMetaOnlySchema.safeParse(body).success;

  it('alt text in both languages, never cleared, at most 300 characters each', () => {
    expect(ok({ alt: { en: 'A dune', ar: 'كثيب' }, version: 1 })).toBe(true);
    expect(ok({ tags: ['brand'], version: 1 })).toBe(true);
    expect(ok({ alt: null, version: 1 })).toBe(false);
    expect(ok({ alt: { en: 'A dune', ar: '' }, version: 1 })).toBe(false);
    expect(ok({ alt: { en: '   ', ar: 'كثيب' }, version: 1 })).toBe(false);
    expect(ok({ alt: { en: 'a'.repeat(300), ar: 'ب' }, version: 1 })).toBe(true);
    expect(ok({ alt: { en: 'a'.repeat(301), ar: 'ب' }, version: 1 })).toBe(false);
    expect(ok({ alt: { en: 'line\nbreak', ar: 'ب' }, version: 1 })).toBe(false);
  });

  it('tags and the folder as an upload: 20 tags of 40, a folder of 200, the folder clearable', () => {
    expect(ok({ tags: Array.from({ length: 20 }, (_, i) => `t${i}`), version: 1 })).toBe(true);
    expect(ok({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`), version: 1 })).toBe(false);
    expect(ok({ tags: ['x'.repeat(41)], version: 1 })).toBe(false);
    expect(ok({ folder: 'f'.repeat(200), version: 1 })).toBe(true);
    expect(ok({ folder: 'f'.repeat(201), version: 1 })).toBe(false);
    expect(ok({ folder: null, version: 1 })).toBe(true);
  });
});
