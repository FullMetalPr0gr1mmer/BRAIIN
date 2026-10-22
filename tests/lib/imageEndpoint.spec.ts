import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { APIContext } from 'astro';
import sharp from 'sharp';
import { checkImageRequest, TRANSFORM_WIDTHS } from '@/lib/http/imageGuard';
import { mediaPublicUrl, storageThumbUrl } from '@/lib/media/storageUrl';
import {
  IMAGE_ENDPOINT_ENTRYPOINT,
  imageEndpointIntegration,
} from '../../scripts/image-endpoint.mjs';

// The `/_image` endpoint (src/lib/http/imageEndpoint.ts, U3 review). What these hold:
//   • the guard runs on the route itself, so no spelling of the path steps around it;
//   • a bundled still goes to the adapter's endpoint, untouched;
//   • an upload is transformed only when the bucket returned a real WebP: a missing key, a
//     redirect or any other type is a 404 with no binding call (the adapter would have
//     handed Supabase's JSON error to the binding);
//   • an upload's derivative is cached for an hour, not the adapter's immutable year;
//   • an upload is transformed by its width alone, so a derivative is exactly as wide as the
//     markup asked (a box of w x rounded h came back a pixel narrower: 319 for 320, U3 e2e);
//   • the integration registers it as `image.endpoint` after the adapter.

const state = vi.hoisted(() => ({
  binding: true,
  bindingThrows: false,
  calls: [] as Record<string, unknown>[],
}));

vi.mock('cloudflare:workers', () => ({
  env: {
    get IMAGES() {
      if (!state.binding) return undefined;
      return {
        input(stream: ReadableStream<Uint8Array>) {
          return {
            transform(t: Record<string, unknown>) {
              return {
                async output(o: { format: string; quality: number }) {
                  if (state.bindingThrows) throw Object.assign(new Error('images'), { code: 9422 });
                  await new Response(stream).arrayBuffer();
                  state.calls.push({ ...t, ...o });
                  return {
                    response: () =>
                      new Response(new Uint8Array([7, 7, 7]), {
                        headers: { 'content-type': o.format },
                      }),
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

const STILL = '/_astro/rider.B1x2y3.jpg';
const adapter = vi.hoisted(() => vi.fn(async () => new Response('adapter', { status: 200 })));
vi.mock('@astrojs/cloudflare/image-transform-endpoint', () => ({ GET: adapter }));
// Built stills are not ESM images under vitest, so one is admitted here by name.
vi.mock('@/lib/http/imageGuard', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/http/imageGuard')>('@/lib/http/imageGuard');
  return {
    ...actual,
    checkImageRequest: (params: URLSearchParams) =>
      actual.checkImageRequest(params, new Map([[STILL, { width: 1920, height: 1080 }]])),
  };
});

const { GET, UPLOAD_DERIVATIVE_MAX_AGE, uploadTransform } =
  await import('@/lib/http/imageEndpoint');

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY = `${TENANT}/33333333-3333-4333-8333-333333333333_1200x800.webp`;
const THUMB = storageThumbUrl(KEY)!;
const HREF = new URL(THUMB, 'https://x.test').searchParams.get('href')!;

const waits: Promise<unknown>[] = [];
function ctx(pathAndQuery: string): APIContext {
  const request = new Request(`https://www.example.test${pathAndQuery}`);
  return {
    request,
    url: new URL(request.url),
    locals: { cfContext: { waitUntil: (p: Promise<unknown>) => waits.push(p) } },
  } as unknown as APIContext;
}

async function call(pathAndQuery: string): Promise<Response> {
  return (await GET(ctx(pathAndQuery))) as Response;
}

let fetched: string[] = [];
let upstream: () => Response;
const realCaches = (globalThis as { caches?: unknown }).caches;

beforeEach(() => {
  state.binding = true;
  state.bindingThrows = false;
  state.calls = [];
  adapter.mockClear();
  fetched = [];
  waits.length = 0;
  upstream = () =>
    new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/webp' } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    fetched.push(String(input));
    expect(init).toMatchObject({ redirect: 'manual' });
    return upstream();
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  (globalThis as { caches?: unknown }).caches = realCaches;
});

describe('the /_image endpoint', () => {
  it('runs the guard itself: a transform the markup never emits is a 400, nothing fetched', async () => {
    const res = await call(THUMB.replace('w=320', 'w=333'));
    expect(res.status).toBe(400);
    expect(await call(`${THUMB}&q=1`)).toMatchObject({ status: 400 });
    expect(await call(THUMB.replace('f=webp', 'f=png'))).toMatchObject({ status: 400 });
    expect(fetched).toEqual([]);
    expect(adapter).not.toHaveBeenCalled();
  });

  it('a bundled still goes to the adapter, unchanged', async () => {
    const res = await call(`/_image?href=${encodeURIComponent(STILL)}&w=800&h=450&f=avif`);
    expect(await res.text()).toBe('adapter');
    expect(adapter).toHaveBeenCalledOnce();
    expect(fetched).toEqual([]);
  });

  it('an upload is fetched from the bucket and transformed, cached for an hour', async () => {
    const res = await call(THUMB);
    expect(res.status).toBe(200);
    expect(fetched).toEqual([HREF]);
    // The width alone (no `height` key at all), scaled down: see the describe below.
    expect(state.calls).toStrictEqual([
      { width: 320, fit: 'scale-down', format: 'image/webp', quality: 85 },
    ]);
    expect(res.headers.get('cache-control')).toBe(`public, max-age=${UPLOAD_DERIVATIVE_MAX_AGE}`);
    expect(UPLOAD_DERIVATIVE_MAX_AGE).toBe(3600);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(adapter).not.toHaveBeenCalled();
  });

  it('a square upload asked as a site icon (PNG at a listed size) is transformed to PNG (U9)', async () => {
    // The guard admits PNG for an icon only (imageGuard.ts checkIcon); the endpoint's own
    // format table must carry it too, or every icon link in the head is a 400 (U9 e2e).
    const square = storageThumbUrl(`${TENANT}/44444444-4444-4444-8444-444444444444_600x600.webp`)!;
    const href = new URL(square, 'https://x.test').searchParams.get('href')!;
    const res = await call(`/_image?href=${encodeURIComponent(href)}&w=32&h=32&f=png`);
    expect(res.status).toBe(200);
    expect(fetched).toEqual([href]);
    expect(state.calls).toStrictEqual([
      { width: 32, fit: 'scale-down', format: 'image/png', quality: 85 },
    ]);
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  it.each([
    [
      'a missing object (the bucket answers JSON)',
      () => Response.json({ error: 'not_found' }, { status: 400 }),
    ],
    [
      'a 200 that is not WebP',
      () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    ],
    [
      'a redirect',
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } }),
    ],
  ])('%s is a 404, and the binding is never called', async (_label, answer) => {
    upstream = answer;
    const res = await call(THUMB);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(state.calls).toEqual([]);
  });

  it('a binding that refuses (the monthly quota) is a 502 that nothing caches', async () => {
    state.bindingThrows = true;
    const res = await call(THUMB);
    expect(res.status).toBe(502);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('no binding: a 404', async () => {
    state.binding = false;
    expect((await call(THUMB)).status).toBe(404);
    expect(fetched).toEqual([]);
  });

  it('uses the zone cache where there is one: a hit costs no fetch, a miss is stored', async () => {
    const stored = new Map<string, Response>();
    (globalThis as { caches?: unknown }).caches = {
      default: {
        match: async (key: string) => stored.get(key)?.clone(),
        put: async (key: string, res: Response) => void stored.set(key, res),
      },
    };
    const first = await call(THUMB);
    await Promise.all(waits);
    expect(first.status).toBe(200);
    const [key] = [...stored.keys()];
    expect(key).toBe(`https://www.example.test${THUMB}`);
    expect(stored.get(key!)?.headers.get('cache-control')).toBe('public, max-age=3600');

    const second = await call(THUMB);
    expect(second.status).toBe(200);
    expect(fetched).toEqual([HREF]); // the second came from the cache
  });
});

/**
 * What wrangler dev's local Images binding (the one the CI e2e runs through) makes of a
 * transform: sharp, with Cloudflare's `fit` mapped as miniflare maps it (`resolveFit` in
 * node_modules/miniflare/dist/src/index.js: scale-down, and no `fit` at all, is sharp's
 * `inside` without enlargement; a width and a height are a box the image fits inside, as in
 * production). Only the size comes back; no pixels are encoded.
 */
async function localBinding(
  source: { width: number; height: number },
  transform: { width?: number; height?: number; fit?: string },
): Promise<{ width: number; height: number }> {
  expect(transform.fit ?? 'scale-down', 'a fit this model knows').toBe('scale-down');
  const { info } = await sharp({
    create: { width: source.width, height: source.height, channels: 3, background: '#1e5aa0' },
  })
    .resize(transform.width ?? null, transform.height ?? null, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height };
}

describe("an upload's derivative is exactly the width the markup asks for", () => {
  // The e2e's master (a 3000x2000 photo at 2,560 px), the thumbnail spec's key, a portrait,
  // a half-pixel tie (1200x798 at 100 px is 66.5 high), and a panorama near the 100 to 1 bound.
  const MASTERS = [
    [2560, 1707],
    [1200, 800],
    [1707, 2560],
    [1200, 798],
    [2560, 26],
  ] as const;

  it('the box the endpoint used to send came back a pixel narrower (the root cause)', async () => {
    // w=320&h=213 for a 2560x1707 master: 213/1707 < 320/2560, so the height was the limit.
    expect(await localBinding({ width: 2560, height: 1707 }, { width: 320, height: 213 })).toEqual({
      width: 319,
      height: 213,
    });
  });

  it('the two heights the guard admits on a half pixel are one transformation', () => {
    const href = mediaPublicUrl(`${TENANT}/66666666-6666-4666-8666-666666666666_1200x798.webp`)!;
    const [low, high] = ['66', '67'].map((h) => {
      const params = new URLSearchParams({ href, w: '100', h, f: 'webp' });
      expect(checkImageRequest(params).ok, `h=${h}`).toBe(true);
      return uploadTransform(params);
    });
    expect(low).toStrictEqual(high);
  });

  it.each(MASTERS)(
    '%ix%i: every width the guard admits is served exactly, at the aspect',
    async (W, H) => {
      const href = mediaPublicUrl(`${TENANT}/66666666-6666-4666-8666-666666666666_${W}x${H}.webp`);
      expect(href, 'a key the parser accepts').not.toBeNull();
      const widths = [...TRANSFORM_WIDTHS].filter((w) => w < W).concat(W);
      for (const w of widths) {
        // The height Astro writes for a width alone, and MediaImage for the real size.
        const h = Math.round((w * H) / W);
        const params = new URLSearchParams({ href: href!, w: String(w), h: String(h), f: 'webp' });
        expect(checkImageRequest(params).ok, `${w}x${h} is admitted`).toBe(true);
        const transform = uploadTransform(params);
        const out = await localBinding({ width: W, height: H }, transform);
        expect(out.width, `${W}x${H} at w=${w}`).toBe(w);
        expect(Math.abs(out.height - (w * H) / W), `${W}x${H} at w=${w}`).toBeLessThanOrEqual(0.5);
        expect(transform).toStrictEqual({ width: w, fit: 'scale-down' });
      }
    },
  );
});

describe('the integration that registers it', () => {
  it('sets image.endpoint after the adapter (which sets its own)', () => {
    const updateConfig = vi.fn();
    const hook = imageEndpointIntegration().hooks['astro:config:setup'] as (o: unknown) => void;
    hook({ updateConfig });
    expect(updateConfig).toHaveBeenCalledWith({
      image: { endpoint: { route: '/_image', entrypoint: IMAGE_ENDPOINT_ENTRYPOINT } },
    });
    expect(IMAGE_ENDPOINT_ENTRYPOINT).toBe('./src/lib/http/imageEndpoint.ts');
  });

  it('astro.config.mjs lists it after the adapter is set (integration order)', async () => {
    const { readFileSync } = await import('node:fs');
    const config = readFileSync('astro.config.mjs', 'utf8');
    expect(config).toMatch(/integrations:\s*\[[^\]]*imageEndpointIntegration\(\)[^\]]*\]/);
  });
});
