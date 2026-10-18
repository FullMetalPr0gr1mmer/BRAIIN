import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIContext, APIRoute } from 'astro';
import sharp from 'sharp';
import { encodeMediaMeta, MEDIA_META_HEADER, parseStorageKey } from '@schemas/media';
import { readWebp } from '@/lib/media/webp';
import { reencode, type ImagesLike } from '@/lib/media/upload';

// The upload pipeline end to end (Admin v2 U3), over a stubbed database and a stand-in for
// the Images binding that does what the binding does (sharp: EXIF rotation, scale-down to
// the long edge, one WebP frame). What these hold:
//   • the order: header checks, then the live recheck, then the head sniffed, then the daily
//     limit, then the binding, then the object, then the row AS THE CALLER, then the audit;
//   • a refused file (SVG, oversized, too many pixels, a missing size) costs no limit slot,
//     no transformation and no object, and the body is not read when the header refuses;
//   • only the re-encoded WebP is stored: GPS and camera EXIF never reach the bucket, even
//     from a binding that kept them; the row's size is the OUTPUT's;
//   • a refused row deletes its object again; a replace keeps the old object for the sweep;
//   • delete removes the object of an uploaded image (only one under the tenant's prefix);
//   • download streams the stored WebP as an attachment.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = '11111111-1111-4111-8111-111111111111';
const ASSET = '22222222-2222-4222-8222-222222222222';

const state = vi.hoisted(() => ({
  configured: true,
  binding: true,
  bindingError: null as null | { code: number },
  bindingKeepsExif: false,
  live: true,
  limited: false,
  insertError: null as null | { code: string; message: string },
  stored: null as Record<string, unknown> | null,
  events: [] as string[],
  uploads: [] as { key: string; bytes: Uint8Array; options: Record<string, unknown> }[],
  removed: [] as string[][],
  lookups: [] as string[],
  namedBy: 0,
  lookupError: false,
  inserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  audits: [] as { action: string; detail?: Record<string, unknown> }[],
  // What media_usage answers (v4, 0066: a fourth column, `pending`).
  usage: [] as Record<string, unknown>[],
}));

vi.mock('cloudflare:workers', () => ({
  env: {
    get IMAGES() {
      if (!state.binding) return undefined;
      return {
        input(stream: ReadableStream<Uint8Array>) {
          return {
            transform(t: { width: number; height: number }) {
              return {
                async output(o: { format: string; quality: number; anim: boolean }) {
                  state.events.push('binding');
                  if (state.bindingError)
                    throw Object.assign(new Error('images'), state.bindingError);
                  const input = Buffer.from(await new Response(stream).arrayBuffer());
                  let out = await sharp(input)
                    .rotate()
                    .resize({
                      width: t.width,
                      height: t.height,
                      fit: 'inside',
                      withoutEnlargement: true,
                    })
                    .webp({ quality: o.quality })
                    .toBuffer();
                  if (state.bindingKeepsExif) {
                    out = await sharp(out)
                      .webp()
                      .withExif({ IFD0: { ImageDescription: 'GPS 24.7136 N 46.6753 E' } })
                      .toBuffer();
                  }
                  return {
                    image: () => new Response(out).body!,
                    contentType: () => 'image/webp',
                  };
                },
              };
            },
          };
        },
      };
    },
  },
}));
vi.mock('@/lib/supabase/client', () => ({ supabaseConfigured: () => state.configured }));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
vi.mock('@/lib/admin/audit', () => ({
  writeAudit: async (_sb: unknown, _auth: unknown, entry: { action: string }) => {
    state.events.push(`audit:${entry.action}`);
    state.audits.push(entry);
    return true;
  },
}));
vi.mock('@/lib/admin/liveRecheck', async () => {
  const { AuthorizationError } = await import('@/lib/authz/errors');
  return {
    liveRecheck: async () => {
      state.events.push('live');
      if (!state.live) throw new AuthorizationError('live-recheck', 'role changed');
    },
  };
});
vi.mock('@/lib/admin/rateLimit', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/admin/rateLimit')>('@/lib/admin/rateLimit');
  const { RateLimitError } = await import('@/lib/admin/errors');
  return {
    ...actual,
    claimPrivilegedOp: async (_a: unknown, op: string, limits: unknown) => {
      state.events.push(`limit:${op}`);
      expect(limits).toEqual(actual.MEDIA_UPLOAD_LIMITS);
      if (state.limited) throw new RateLimitError(`${op}:user`);
    },
  };
});
vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    // "Does any row still name this file?" (removeObjectIfUnnamed), as the service role.
    from: (table: string) => ({
      select: (_cols: string, opts: { count?: string; head?: boolean }) => ({
        eq: async (column: string, value: string) => {
          expect([table, column, opts]).toEqual([
            'media_assets',
            'storage_path',
            { count: 'exact', head: true },
          ]);
          state.lookups.push(value);
          return state.lookupError
            ? { count: null, error: { code: '57014', message: 'timeout' } }
            : { count: state.namedBy, error: null };
        },
      }),
    }),
    storage: {
      from: (bucket: string) => ({
        upload: async (key: string, bytes: Uint8Array, options: Record<string, unknown>) => {
          expect(bucket).toBe('media');
          state.events.push('object');
          state.uploads.push({ key, bytes, options });
          return { error: null };
        },
        remove: async (keys: string[]) => {
          expect(bucket).toBe('media');
          state.events.push('remove');
          state.removed.push(keys);
          return { error: null };
        },
      }),
    },
  }),
}));

/** The caller's own client: media_assets reads and writes, under RLS in real life. */
function userClient() {
  return {
    from(table: string) {
      const q = { op: 'select', values: {} as Record<string, unknown> };
      const answer = () => {
        if (table !== 'media_assets') return { data: null, error: null };
        if (q.op === 'insert') {
          state.events.push('row');
          if (state.insertError) return { data: null, error: state.insertError };
          state.inserts.push(q.values);
          return { data: { id: ASSET, version: 1, ...q.values }, error: null };
        }
        if (q.op === 'update') {
          state.events.push('row');
          state.updates.push(q.values);
          return { data: { ...state.stored, ...q.values, version: 2 }, error: null };
        }
        if (q.op === 'delete') return { data: [{ id: ASSET }], error: null };
        return { data: state.stored, error: null };
      };
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) b[m] = () => b;
      b['insert'] = (v: Record<string, unknown>) => ((q.op = 'insert'), (q.values = v), b);
      b['update'] = (v: Record<string, unknown>) => ((q.op = 'update'), (q.values = v), b);
      b['delete'] = () => ((q.op = 'delete'), b);
      b['single'] = async () => answer();
      b['maybeSingle'] = async () => answer();
      b['then'] = (ok: (v: unknown) => unknown) => Promise.resolve(answer()).then(ok);
      return b;
    },
    rpc: async (fn: string) => {
      if (fn === 'media_usage') return { data: state.usage, error: null };
      if (fn === 'media_storage_stats') return { data: [{ assets: 3, bytes: 4567 }], error: null };
      return { data: null, error: null };
    },
  };
}

function ctx(
  method: string,
  url: string,
  body?: Uint8Array | ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
  role = 'admin',
): APIContext {
  const request = new Request(`https://admin.example.test${url}`, {
    method,
    headers,
    ...(body ? { body, duplex: 'half' } : {}),
  } as RequestInit);
  return {
    request,
    url: new URL(request.url),
    params: { id: ASSET },
    locals: {
      session: { userId: USER, tenantId: TENANT, role, isActive: true, email: 'x@example.test' },
      supabase: userClient(),
      cspNonce: 'test',
      csrfToken: 'test',
    },
  } as unknown as APIContext;
}

const META = { alt: { en: 'A rider at dusk', ar: 'راكب عند الغروب' }, tags: ['reel'] };

function uploadRequest(file: Uint8Array, meta: unknown = { ...META, displayName: 'IMG_0001.jpg' }) {
  return ctx('POST', '/api/admin/media/upload', file, {
    'content-type': 'image/jpeg',
    'content-length': String(file.length),
    [MEDIA_META_HEADER]: encodeMediaMeta(meta),
  });
}

async function call(route: APIRoute, context: APIContext) {
  const res = (await route(context)) as Response;
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  return { res, status: res.status, body: body as Record<string, any> | null };
}

const photo = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 30, g: 90, b: 160 } } })
    .jpeg()
    .withExif({ IFD0: { ImageDescription: 'GPS 24.7136 N 46.6753 E', Make: 'PhoneCo' } })
    .toBuffer()
    .then((b) => new Uint8Array(b));

const { POST: UPLOAD } = await import('@/pages/api/admin/media/upload');
const { POST: REPLACE } = await import('@/pages/api/admin/media/[id]/replace');
const { GET: DOWNLOAD } = await import('@/pages/api/admin/media/[id]/download');
const { DELETE } = await import('@/pages/api/admin/media/[id]');
const { GET: STATS } = await import('@/pages/api/admin/media/stats');
const { GET: USAGE } = await import('@/pages/api/admin/media/[id]/usage');

beforeEach(() => {
  state.configured = true;
  state.binding = true;
  state.bindingError = null;
  state.bindingKeepsExif = false;
  state.live = true;
  state.limited = false;
  state.insertError = null;
  state.stored = null;
  state.events = [];
  state.uploads = [];
  state.removed = [];
  state.lookups = [];
  state.namedBy = 0;
  state.lookupError = false;
  state.inserts = [];
  state.updates = [];
  state.audits = [];
  state.usage = [];
});

describe('POST /api/admin/media/upload', () => {
  it('stores one WebP master, scaled to 2,560 px, with no EXIF, then the row, then the audit', async () => {
    const { status, body } = await call(UPLOAD, uploadRequest(await photo(4000, 3000)));
    expect(status).toBe(200);
    expect(state.events).toEqual([
      'live',
      'limit:media-upload',
      'binding',
      'object',
      'row',
      'audit:media_asset.upload',
    ]);

    const stored = state.uploads[0]!;
    const key = parseStorageKey(stored.key);
    expect(key).toMatchObject({ tenantId: TENANT, width: 2560, height: 1920 });
    expect(readWebp(stored.bytes)).toMatchObject({ width: 2560, height: 1920, metadata: 0 });
    expect(Buffer.from(stored.bytes).includes(Buffer.from('GPS'))).toBe(false);
    expect((await sharp(stored.bytes).metadata()).exif).toBeUndefined();

    expect(state.inserts[0]).toEqual({
      kind: 'image',
      provider: 'storage',
      storage_path: stored.key,
      width: 2560,
      height: 1920,
      mime_type: 'image/webp',
      size_bytes: stored.bytes.length,
      alt: META.alt,
      tags: ['reel'],
      folder: null,
      display_name: 'IMG_0001.jpg',
      tenant_id: TENANT,
    });
    expect(body?.['data']).toMatchObject({ provider: 'storage', width: 2560 });
    expect(String(body?.['data']?.['thumb_url'])).toMatch(/^\/_image\?href=/);
    // The audit names the sizes, never the file's own name.
    expect(state.audits[0]?.detail).toEqual({
      input: 'jpeg',
      inputBytes: expect.any(Number),
      bytes: stored.bytes.length,
      width: 2560,
      height: 1920,
    });
    expect(JSON.stringify(state.audits)).not.toContain('IMG_0001');
  });

  it('stores the object with a one-hour cache lifetime, so a deleted file leaves the CDN', async () => {
    await call(UPLOAD, uploadRequest(await photo(40, 30)));
    expect(state.uploads[0]!.options).toEqual({
      contentType: 'image/webp',
      upsert: false,
      cacheControl: '3600',
    });
  });

  it('a small image keeps its size (never upscaled)', async () => {
    await call(UPLOAD, uploadRequest(await photo(300, 200)));
    expect(parseStorageKey(state.uploads[0]!.key)).toMatchObject({ width: 300, height: 200 });
  });

  it('strips EXIF even when the binding kept it', async () => {
    state.bindingKeepsExif = true;
    await call(UPLOAD, uploadRequest(await photo(400, 300)));
    const bytes = state.uploads[0]!.bytes;
    expect(readWebp(bytes)?.metadata).toBe(0);
    expect(Buffer.from(bytes).includes(Buffer.from('GPS'))).toBe(false);
  });

  it('a renamed SVG is refused by its bytes: 415, no slot, no transformation, no object', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const { status, body } = await call(UPLOAD, uploadRequest(svg));
    expect(status).toBe(415);
    expect(body).toMatchObject({ ok: false, error: 'unsupported-type', reason: 'svg' });
    expect(state.events).toEqual(['live']);
  });

  it('a header past the decompression guard is refused before the binding (422)', async () => {
    // A PNG whose header claims 13,000 px: the pixels are never decoded.
    const real = new Uint8Array(
      await sharp({ create: { width: 2, height: 2, channels: 3, background: '#000' } })
        .png()
        .toBuffer(),
    );
    const view = new DataView(real.buffer);
    view.setUint32(16, 13_000);
    const { crc32 } = await import('node:zlib');
    view.setUint32(29, crc32(real.subarray(12, 29)));
    const { status, body } = await call(UPLOAD, uploadRequest(real));
    expect(status).toBe(422);
    expect(body).toMatchObject({ error: 'image-too-large', reason: 'dimensions' });
    expect(state.events).not.toContain('binding');
  });

  it('a file too long and thin to show is refused before the binding (422), either way round', async () => {
    // MEDIA_MAX_ASPECT: past 100 to 1 a listed width rounds the height to 0, and no /_image
    // URL for the image would be admitted (the admin thumbnail included).
    for (const [w, h] of [
      [2_020, 20],
      [20, 2_020],
    ] as const) {
      state.events = [];
      const { status, body } = await call(UPLOAD, uploadRequest(await photo(w, h)));
      expect(status, `${w}x${h}`).toBe(422);
      expect(body).toMatchObject({ ok: false, error: 'image-too-thin', reason: 'aspect' });
      expect(state.events).toEqual(['live']);
    }
    expect(state.uploads).toEqual([]);
    // At the bound it is stored, and its thumbnail is a URL.
    state.events = [];
    const { status, body } = await call(UPLOAD, uploadRequest(await photo(2_000, 20)));
    expect(status).toBe(200);
    expect(parseStorageKey(state.uploads[0]!.key)).toMatchObject({ width: 2_000, height: 20 });
    expect(String(body?.['data']?.['thumb_url'])).toMatch(/^\/_image\?href=.*&w=320&h=3&f=webp$/);
  });

  it('a master the scaling tipped past 100 to 1 is refused too, before anything is stored', async () => {
    // A binding that rounds the short side down returns 12,000x120 (exactly 100 to 1) as
    // 2,560x25: the key could not name it, so the master is held to the sniffer's rule.
    const master = async (width: number, height: number) =>
      new Uint8Array(
        await sharp({ create: { width, height, channels: 3, background: '#123456' } })
          .webp()
          .toBuffer(),
      );
    const returning = (out: Uint8Array<ArrayBuffer>): ImagesLike => ({
      input: () => ({
        transform: () => ({
          output: async () => ({
            image: () => new Response(out).body!,
            contentType: () => 'image/webp',
          }),
        }),
      }),
    });
    const body = () => new Response(new Uint8Array(8)).body!;
    expect(await reencode(returning(await master(2_560, 25)), body())).toMatchObject({
      status: 422,
      error: 'image-too-thin',
      reason: 'aspect',
    });
    expect(await reencode(returning(await master(25, 2_560)), body())).toMatchObject({
      status: 422,
      reason: 'aspect',
    });
    expect(await reencode(returning(await master(2_560, 26)), body())).toMatchObject({
      width: 2_560,
      height: 26,
    });
  });

  it('no Content-Length: 411, and the body is never read', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        c.enqueue(new Uint8Array(10));
        c.close();
      },
    });
    const context = ctx('POST', '/api/admin/media/upload', stream, {
      [MEDIA_META_HEADER]: encodeMediaMeta(META),
    });
    const { status, body } = await call(UPLOAD, context);
    expect(status).toBe(411);
    expect(body?.['error']).toBe('length-required');
    expect(pulled).toBeLessThanOrEqual(1); // at most the stream's own start-up pull
    expect(state.events).toEqual([]);
  });

  it('over 20 MB by its header: 413 before anything else', async () => {
    const context = ctx('POST', '/api/admin/media/upload', new Uint8Array(8), {
      'content-length': '20000001',
      [MEDIA_META_HEADER]: encodeMediaMeta(META),
    });
    const { status, body } = await call(UPLOAD, context);
    expect(status).toBe(413);
    expect(body?.['error']).toBe('too-large');
    expect(state.events).toEqual([]);
  });

  it('bilingual alt is required, and the details must be readable (422)', async () => {
    const file = await photo(20, 20);
    expect((await call(UPLOAD, uploadRequest(file, { alt: { en: 'Only English' } }))).status).toBe(
      422,
    );
    const noMeta = ctx('POST', '/api/admin/media/upload', file, {
      'content-length': String(file.length),
    });
    expect((await call(UPLOAD, noMeta)).status).toBe(422);
    const extra = await call(UPLOAD, uploadRequest(file, { ...META, storagePath: 'x' }));
    expect(extra.status).toBe(422);
    expect(state.events).toEqual([]);
  });

  it('switched off until the binding and Supabase are there: "Not set up" (503)', async () => {
    state.binding = false;
    const { status, body } = await call(UPLOAD, uploadRequest(await photo(20, 20)));
    expect(status).toBe(503);
    expect(body).toMatchObject({ error: 'not-set-up', detail: 'Uploads are not set up yet.' });
    state.binding = true;
    state.configured = false;
    expect((await call(UPLOAD, uploadRequest(await photo(20, 20)))).status).toBe(503);
  });

  it('the monthly transformation quota (9422) is a 503 with nothing stored', async () => {
    state.bindingError = { code: 9422 };
    const { status, body } = await call(UPLOAD, uploadRequest(await photo(20, 20)));
    expect(status).toBe(503);
    expect(body?.['error']).toBe('images-quota');
    expect(state.uploads).toEqual([]);
  });

  it('a demoted editor (live recheck) gets 403 with nothing claimed or stored', async () => {
    state.live = false;
    expect((await call(UPLOAD, uploadRequest(await photo(20, 20)))).status).toBe(403);
    expect(state.events).toEqual(['live']);
  });

  it('over the daily limit: 429 before the binding', async () => {
    state.limited = true;
    expect((await call(UPLOAD, uploadRequest(await photo(20, 20)))).status).toBe(429);
    expect(state.events).toEqual(['live', 'limit:media-upload']);
  });

  it('a row the database refuses deletes its object again', async () => {
    state.insertError = { code: '42501', message: 'new row violates row-level security policy' };
    const { status } = await call(UPLOAD, uploadRequest(await photo(20, 20)));
    expect(status).toBe(403);
    expect(state.removed).toEqual([[state.uploads[0]!.key]]);
    expect(state.audits).toEqual([]);
  });

  it('SEO (media.write meta only) is refused before anything is read', async () => {
    const file = await photo(20, 20);
    const context = ctx(
      'POST',
      '/api/admin/media/upload',
      file,
      { 'content-length': String(file.length), [MEDIA_META_HEADER]: encodeMediaMeta(META) },
      'seo',
    );
    expect((await call(UPLOAD, context)).status).toBe(403);
    expect(state.events).toEqual([]);
  });
});

describe('POST /api/admin/media/[id]/replace', () => {
  const replaceRequest = (file: Uint8Array, version: number) =>
    ctx('POST', `/api/admin/media/${ASSET}/replace`, file, {
      'content-length': String(file.length),
      [MEDIA_META_HEADER]: encodeMediaMeta({ version, displayName: 'new.png' }),
    });
  const OLD_KEY = `${TENANT}/33333333-3333-4333-8333-333333333333_100x100.webp`;

  it('a stale version is a 409 before the file is read', async () => {
    state.stored = { id: ASSET, kind: 'image', provider: 'storage', version: 4 };
    expect((await call(REPLACE, replaceRequest(await photo(20, 20), 3))).status).toBe(409);
    expect(state.events).toEqual([]);
  });

  it('only an image can be replaced', async () => {
    state.stored = { id: ASSET, kind: 'video', provider: 'stream', version: 1 };
    expect((await call(REPLACE, replaceRequest(await photo(20, 20), 1))).status).toBe(422);
  });

  it('writes a NEW key on the same row and leaves the old object to the sweep', async () => {
    state.stored = {
      id: ASSET,
      kind: 'image',
      provider: 'storage',
      storage_path: OLD_KEY,
      version: 1,
    };
    const { status } = await call(REPLACE, replaceRequest(await photo(640, 480), 1));
    expect(status).toBe(200);
    const update = state.updates[0]!;
    expect(update).toMatchObject({
      provider: 'storage',
      width: 640,
      height: 480,
      mime_type: 'image/webp',
      provider_ref: null,
      stream_uid: null,
      display_name: 'new.png',
    });
    expect(update['storage_path']).not.toBe(OLD_KEY);
    expect(update['storage_path']).toBe(state.uploads[0]!.key);
    expect(state.removed).toEqual([]);
    expect(state.audits[0]).toMatchObject({ action: 'media_asset.replace' });
    expect(state.audits[0]?.detail).not.toHaveProperty('previousFile');
  });

  const removingRequest = (file: Uint8Array) =>
    ctx('POST', `/api/admin/media/${ASSET}/replace`, file, {
      'content-length': String(file.length),
      [MEDIA_META_HEADER]: encodeMediaMeta({ version: 1, removePrevious: true }),
    });

  it('removePrevious takes the old file off the web at once, after the row moved on', async () => {
    state.stored = {
      id: ASSET,
      kind: 'image',
      provider: 'storage',
      storage_path: OLD_KEY,
      version: 1,
    };
    const { status, body } = await call(REPLACE, removingRequest(await photo(64, 48)));
    expect(status).toBe(200);
    expect(state.events.slice(-3)).toEqual(['row', 'remove', 'audit:media_asset.replace']);
    expect(state.lookups).toEqual([OLD_KEY]);
    expect(state.removed).toEqual([[OLD_KEY]]);
    expect(state.audits[0]?.detail).toMatchObject({
      previousFile: 'removed',
      previousKey: OLD_KEY,
    });
    expect(body?.['data']).toMatchObject({ id: ASSET, previous_file: 'removed' });
  });

  it('removePrevious never removes a file another row names, nor one outside the tenant', async () => {
    state.stored = {
      id: ASSET,
      kind: 'image',
      provider: 'storage',
      storage_path: OLD_KEY,
      version: 1,
    };
    state.namedBy = 1;
    const named = await call(REPLACE, removingRequest(await photo(64, 48)));
    expect(named.body?.['data']).toMatchObject({ previous_file: 'still-named' });
    expect(state.removed).toEqual([]);

    state.namedBy = 0;
    state.stored = {
      ...state.stored,
      storage_path: `${OTHER}/33333333-3333-4333-8333-333333333333_100x100.webp`,
    };
    const foreign = await call(REPLACE, removingRequest(await photo(64, 48)));
    expect(foreign.body?.['data']).toMatchObject({ previous_file: 'none' });
    expect(state.removed).toEqual([]);
  });
});

describe('DELETE /api/admin/media/[id] (an uploaded image)', () => {
  it('removes its object once the row is gone', async () => {
    const key = `${TENANT}/44444444-4444-4444-8444-444444444444_10x10.webp`;
    state.stored = { id: ASSET, provider: 'storage', storage_path: key };
    const { status, body } = await call(DELETE, ctx('DELETE', `/api/admin/media/${ASSET}`));
    expect(status).toBe(200);
    expect(state.lookups).toEqual([key]);
    expect(state.removed).toEqual([[key]]);
    expect(body?.['data']).toEqual({ deleted: ASSET, fileRemoved: true });
  });

  it('keeps the object when another row still names it, or the lookup fails', async () => {
    const key = `${TENANT}/44444444-4444-4444-8444-444444444444_10x10.webp`;
    state.stored = { id: ASSET, provider: 'storage', storage_path: key };
    state.namedBy = 1;
    const named = await call(DELETE, ctx('DELETE', `/api/admin/media/${ASSET}`));
    expect(named.body?.['data']).toEqual({
      deleted: ASSET,
      fileRemoved: false,
      fileKept: 'still-named',
    });
    expect(state.audits[0]?.detail).toEqual({ fileRemoved: false, fileKept: 'still-named' });

    state.namedBy = 0;
    state.lookupError = true;
    const unsure = await call(DELETE, ctx('DELETE', `/api/admin/media/${ASSET}`));
    expect(unsure.body?.['data']).toMatchObject({ fileRemoved: false, fileKept: 'lookup-failed' });
    expect(state.removed).toEqual([]);
  });

  it("never removes an object outside the tenant's own prefix", async () => {
    state.stored = {
      id: ASSET,
      provider: 'storage',
      storage_path: `${OTHER}/44444444-4444-4444-8444-444444444444_10x10.webp`,
    };
    await call(DELETE, ctx('DELETE', `/api/admin/media/${ASSET}`));
    expect(state.removed).toEqual([]);
  });

  it('a still shipped with the site has no object to remove', async () => {
    state.stored = { id: ASSET, provider: 'static', storage_path: 'stills/work/p0.jpg' };
    await call(DELETE, ctx('DELETE', `/api/admin/media/${ASSET}`));
    expect(state.removed).toEqual([]);
  });
});

describe('media_usage v4: pending changes are references (0066, Admin v2 R5)', () => {
  const live = { entity_type: 'service', entity_id: OTHER, label: 'logo', pending: false };
  const pending = {
    entity_type: 'page_section',
    entity_id: USER,
    label: 'Home hero',
    pending: true,
  };

  it('the usage answer passes `pending` through', async () => {
    state.stored = { id: ASSET, provider: 'static', storage_path: 'stills/work/p0.jpg' };
    state.usage = [live, pending];
    const { status, body } = await call(USAGE, ctx('GET', `/api/admin/media/${ASSET}/usage`));
    expect(status).toBe(200);
    expect(body?.['data']).toEqual({
      id: ASSET,
      inUse: true,
      usage: [
        { entityType: 'service', entityId: OTHER, label: 'logo', pending: false },
        { entityType: 'page_section', entityId: USER, label: 'Home hero', pending: true },
      ],
    });
  });

  it('a row without `pending` (a database before v4) reads as live; an unknown column is ignored', async () => {
    state.stored = { id: ASSET, provider: 'static', storage_path: 'stills/work/p0.jpg' };
    state.usage = [{ entity_type: 'client', entity_id: OTHER, label: 'acme', later: 'x' }];
    const { body } = await call(USAGE, ctx('GET', `/api/admin/media/${ASSET}/usage`));
    expect(body?.['data']?.['usage']).toEqual([
      { entityType: 'client', entityId: OTHER, label: 'acme', pending: false },
    ]);
  });

  it('a hard delete waits for a pending change, and says it is one', async () => {
    state.stored = { id: ASSET, provider: 'static', storage_path: 'stills/work/p0.jpg' };
    state.usage = [pending];
    const { status, body } = await call(DELETE, ctx('DELETE', `/api/admin/media/${ASSET}`));
    expect(status).toBe(409);
    expect(JSON.stringify(body)).toContain('a pending change to page section Home hero');
    expect(state.audits).toEqual([]);
  });

  it('a live reference keeps its plain words', async () => {
    state.stored = { id: ASSET, provider: 'static', storage_path: 'stills/work/p0.jpg' };
    state.usage = [live];
    const { status, body } = await call(DELETE, ctx('DELETE', `/api/admin/media/${ASSET}`));
    expect(status).toBe(409);
    expect(JSON.stringify(body)).toContain('still used by 1 item(s): service logo');
    expect(JSON.stringify(body)).not.toContain('pending');
  });
});

describe('GET /api/admin/media/[id]/download and /stats', () => {
  it('streams the stored WebP as an attachment, named after the upload', async () => {
    const key = `${TENANT}/55555555-5555-4555-8555-555555555555_10x10.webp`;
    state.stored = {
      id: ASSET,
      provider: 'storage',
      storage_path: key,
      display_name: 'Rider "1".JPG',
    };
    const fetched: string[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      fetched.push(String(input));
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '3' } });
    });
    try {
      const { res } = await call(DOWNLOAD, ctx('GET', `/api/admin/media/${ASSET}/download`));
      expect(res.status).toBe(200);
      expect(fetched).toEqual([
        `https://example.supabase.co/storage/v1/object/public/media/${key}`,
      ]);
      expect(res.headers.get('content-disposition')).toBe(
        `attachment; filename="Rider -1.webp"; filename*=UTF-8''Rider%20%221%22.webp`,
      );
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toBe('sandbox');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    } finally {
      spy.mockRestore();
    }
  });

  it('a row with no stored file is a 404', async () => {
    state.stored = { id: ASSET, provider: 'static', storage_path: 'stills/work/p0.jpg' };
    expect((await call(DOWNLOAD, ctx('GET', `/api/admin/media/${ASSET}/download`))).status).toBe(
      404,
    );
  });

  it("storage used, against the plan's quota", async () => {
    const { body } = await call(STATS, ctx('GET', '/api/admin/media/stats'));
    expect(body?.['data']).toEqual({ assets: 3, bytes: 4567, quotaBytes: 1_073_741_824 });
  });
});
