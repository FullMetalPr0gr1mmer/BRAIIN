import { describe, it, expect } from 'vitest';
import { isMediaPath, MEDIA_CACHE_CONTROL, serveMedia } from '@/lib/http/media';

// The /media/*.mp4 Worker route (src/worker.ts → src/lib/http/media.ts, EXC-009). The asset
// store is faked the way the real one behaves: it ignores Range, answers 200 with the whole
// file and its length, and 304s a matching If-None-Match.

const FILE = Uint8Array.from({ length: 256 }, (_, i) => i);
const ETAG = '"showreel-v1"';
const LAST_MODIFIED = 'Wed, 24 Sep 2026 10:00:00 GMT';
const ORIGIN = 'https://www.braiinstation.com';

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function fakeAssets(opts: { files?: Record<string, Uint8Array>; noLength?: boolean } = {}) {
  const files = opts.files ?? { '/media/showreel.mp4': FILE };
  const seen: Seen[] = [];
  return {
    seen,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      seen.push({ url: req.url, method: req.method, headers: Object.fromEntries(req.headers) });
      const file = files[url.pathname];
      if (!file) return new Response('not found', { status: 404 });
      if (req.headers.get('if-none-match') === ETAG) {
        return new Response(null, { status: 304, headers: { etag: ETAG } });
      }
      const headers = new Headers({
        'content-type': 'video/mp4',
        etag: ETAG,
        'last-modified': LAST_MODIFIED,
        'cache-control': 'public, max-age=0, must-revalidate',
      });
      if (!opts.noLength) headers.set('content-length', String(file.byteLength));
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(file.slice(0, 100));
          c.enqueue(file.slice(100));
          c.close();
        },
      });
      return new Response(body, { status: 200, headers });
    },
  };
}

function req(path: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return new Request(`${ORIGIN}${path}`, init);
}

async function bytes(res: Response): Promise<number[]> {
  return [...new Uint8Array(await res.arrayBuffer())];
}

const span = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

describe('isMediaPath — only /media/*.mp4, no traversal', () => {
  it.each(['/media/showreel.mp4', '/media/work/the-rider_01.mp4', '/media/a-b/c.mp4'])(
    'serves %s',
    (p) => expect(isMediaPath(p)).toBe(true),
  );

  it.each([
    '/media/hero-poster-blur.jpg',
    '/media/showreel.MP4',
    '/media/showreel.mp4.bak',
    '/media/../wrangler.json',
    '/media/..%2fserver/.dev.vars',
    '/media/%2e%2e/x.mp4',
    '/media/.hidden.mp4',
    '/media/a.b.mp4',
    '/media//showreel.mp4',
    '/media/',
    '/media/.mp4',
    '/showreel.mp4',
    '/_astro/showreel.mp4',
    '/mediax/showreel.mp4',
    '/media\\showreel.mp4',
  ])('refuses %s', (p) => expect(isMediaPath(p)).toBe(false));
});

describe('serveMedia', () => {
  it('returns null for any other path (Astro handles it) without touching the store', async () => {
    const assets = fakeAssets();
    expect(await serveMedia(req('/'), assets)).toBeNull();
    expect(await serveMedia(req('/media/hero-poster-blur.jpg'), assets)).toBeNull();
    expect(assets.seen).toHaveLength(0);
  });

  it('a missing file falls through to Astro (its real 404 page)', async () => {
    expect(await serveMedia(req('/media/nope.mp4'), fakeAssets())).toBeNull();
  });

  it('no Range → 200, the whole file, Accept-Ranges advertised', async () => {
    const res = (await serveMedia(req('/media/showreel.mp4'), fakeAssets()))!;
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe('256');
    expect(res.headers.get('content-range')).toBeNull();
    expect(await bytes(res)).toEqual(span(0, 255));
  });

  it('bytes=a-b → 206 with Content-Range and exactly that window', async () => {
    const res = (await serveMedia(
      req('/media/showreel.mp4', { headers: { range: 'bytes=90-109' } }),
      fakeAssets(),
    ))!;
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 90-109/256');
    expect(res.headers.get('content-length')).toBe('20');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(await bytes(res)).toEqual(span(90, 109));
  });

  it('bytes=0- (a <video>’s first request) → 206 of the whole file', async () => {
    const res = (await serveMedia(
      req('/media/showreel.mp4', { headers: { range: 'bytes=0-' } }),
      fakeAssets(),
    ))!;
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-255/256');
    expect(await bytes(res)).toEqual(span(0, 255));
  });

  it('bytes=-n → the tail', async () => {
    const res = (await serveMedia(
      req('/media/showreel.mp4', { headers: { range: 'bytes=-6' } }),
      fakeAssets(),
    ))!;
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 250-255/256');
    expect(await bytes(res)).toEqual(span(250, 255));
  });

  it('an unsatisfiable range → 416 with bytes */size and no body', async () => {
    const res = (await serveMedia(
      req('/media/showreel.mp4', { headers: { range: 'bytes=999-' } }),
      fakeAssets(),
    ))!;
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */256');
    expect(await bytes(res)).toEqual([]);
  });

  it('multi-range → 200 with the whole file', async () => {
    const res = (await serveMedia(
      req('/media/showreel.mp4', { headers: { range: 'bytes=0-1,5-9' } }),
      fakeAssets(),
    ))!;
    expect(res.status).toBe(200);
    expect(await bytes(res)).toHaveLength(256);
  });

  it('If-Range with a stale ETag → 200 with the whole file; with the current one → 206', async () => {
    const stale = (await serveMedia(
      req('/media/showreel.mp4', { headers: { range: 'bytes=0-9', 'if-range': '"old"' } }),
      fakeAssets(),
    ))!;
    expect(stale.status).toBe(200);
    expect(await bytes(stale)).toHaveLength(256);

    const current = (await serveMedia(
      req('/media/showreel.mp4', { headers: { range: 'bytes=0-9', 'if-range': ETAG } }),
      fakeAssets(),
    ))!;
    expect(current.status).toBe(206);
  });

  it('HEAD → the GET headers, no body; HEAD with Range → 206 headers', async () => {
    const head = (await serveMedia(req('/media/showreel.mp4', { method: 'HEAD' }), fakeAssets()))!;
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('256');
    expect(head.headers.get('accept-ranges')).toBe('bytes');
    expect(head.body).toBeNull();

    const ranged = (await serveMedia(
      req('/media/showreel.mp4', { method: 'HEAD', headers: { range: 'bytes=0-9' } }),
      fakeAssets(),
    ))!;
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe('bytes 0-9/256');
    expect(ranged.body).toBeNull();
  });

  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('%s → 405 with Allow, store untouched', async (m) => {
    const assets = fakeAssets();
    const res = (await serveMedia(req('/media/showreel.mp4', { method: m }), assets))!;
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
    expect(assets.seen).toHaveLength(0);
  });

  it('a matching If-None-Match comes back 304 from the store and is passed on', async () => {
    const res = (await serveMedia(
      req('/media/showreel.mp4', { headers: { 'if-none-match': ETAG } }),
      fakeAssets(),
    ))!;
    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe(ETAG);
  });

  it('forwards ONLY the validators to the store — no cookies, no Range, always a GET', async () => {
    const assets = fakeAssets();
    await serveMedia(
      req('/media/showreel.mp4', {
        method: 'HEAD',
        headers: {
          cookie: '__Host-sb=secret',
          authorization: 'Bearer x',
          range: 'bytes=0-9',
          'if-none-match': '"nope"',
        },
      }),
      assets,
    );
    expect(assets.seen).toHaveLength(1);
    const seen = assets.seen[0]!;
    expect(seen.method).toBe('GET');
    expect(seen.url).toBe(`${ORIGIN}/media/showreel.mp4`);
    expect(seen.headers).toEqual({ 'if-none-match': '"nope"' });
  });

  it('drops the query string on the store fetch (one file, one cache entry)', async () => {
    const assets = fakeAssets();
    await serveMedia(req('/media/showreel.mp4?v=2'), assets);
    expect(assets.seen[0]!.url).toBe(`${ORIGIN}/media/showreel.mp4`);
  });

  it('carries video/mp4, the long media Cache-Control, validators and the security headers', async () => {
    const res = (await serveMedia(
      req('/media/showreel.mp4', { headers: { range: 'bytes=0-9' } }),
      fakeAssets(),
    ))!;
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('cache-control')).toBe(MEDIA_CACHE_CONTROL);
    expect(res.headers.get('etag')).toBe(ETAG);
    expect(res.headers.get('last-modified')).toBe(LAST_MODIFIED);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(res.headers.get('content-security-policy')).not.toContain('unsafe-inline');
  });

  it('a store response without Content-Length is buffered once, and ranges still work', async () => {
    const res = (await serveMedia(
      req('/media/showreel.mp4', { headers: { range: 'bytes=250-' } }),
      fakeAssets({ noLength: true }),
    ))!;
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 250-255/256');
    expect(await bytes(res)).toEqual(span(250, 255));
  });

  it('an empty file: 200 without Range, 416 with one', async () => {
    const files = { '/media/empty.mp4': new Uint8Array(0) };
    const full = (await serveMedia(req('/media/empty.mp4'), fakeAssets({ files })))!;
    expect(full.status).toBe(200);
    expect(full.headers.get('content-length')).toBe('0');
    const ranged = (await serveMedia(
      req('/media/empty.mp4', { headers: { range: 'bytes=0-' } }),
      fakeAssets({ files }),
    ))!;
    expect(ranged.status).toBe(416);
    expect(ranged.headers.get('content-range')).toBe('bytes */0');
  });
});
