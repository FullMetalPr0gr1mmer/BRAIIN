import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASSET_CSP, STATIC_SECURITY_HEADERS } from '@/lib/http/securityHeaders';

// src/worker.ts — the Worker entry: the /media byte-range route, then Astro's `handle`,
// with every response passing the security-header backstop (CLAUDE.md §2, amendment
// 2026-10) and a thrown error turned into a secured 500 instead of Cloudflare's 1101 page.
//
// The adapter's handler is mocked: the real one needs the build's virtual modules. What it
// returns here are the responses Astro produces BEFORE src/middleware.ts runs (measured
// under `wrangler dev`, tests/e2e/security-headers.e2e.ts): bare, header-less objects.

const mocks = vi.hoisted(() => ({
  handle: vi.fn<(request: Request, env: unknown, ctx: unknown) => Promise<Response>>(),
  runDailyJobs: vi.fn<() => Promise<void>>(),
  writeSystemLog: vi.fn<(entry: unknown) => Promise<boolean>>(),
}));
vi.mock('@astrojs/cloudflare/handler', () => ({ handle: mocks.handle }));
vi.mock('@/lib/cron/daily', () => ({ runDailyJobs: mocks.runDailyJobs }));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: mocks.writeSystemLog }));

const { default: worker } = await import('@/worker');

const ORIGIN = 'https://example.test';
const MP4 = Uint8Array.from({ length: 64 }, (_, i) => i);

function fakeAssets() {
  const fetch = vi.fn(async (req: Request): Promise<Response> => {
    if (new URL(req.url).pathname !== '/media/showreel.mp4')
      return new Response(null, { status: 404 });
    return new Response(MP4, {
      headers: { 'content-type': 'video/mp4', 'content-length': String(MP4.byteLength) },
    });
  });
  return { fetch };
}

function fakeCtx() {
  return { waitUntil: vi.fn<(p: Promise<unknown>) => void>(), passThroughOnException: vi.fn() };
}

const run = (path: string, init?: RequestInit, env = { ASSETS: fakeAssets() }, ctx = fakeCtx()) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, init) as never, env as never, ctx as never);

const expectSecured = (res: Response) => {
  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) {
    expect(res.headers.get(name), name).toBe(value);
  }
  const csp = res.headers.get('Content-Security-Policy') ?? '';
  // ONE policy: a second header would come back comma-joined, with a second default-src.
  expect(csp.match(/default-src/g)).toHaveLength(1);
  expect(new Set([...csp.matchAll(/'nonce-([^']+)'/g)].map((m) => m[1])).size).toBe(1);
  expect(csp).not.toContain('unsafe-inline');
};

beforeEach(() => {
  mocks.handle.mockReset();
  mocks.runDailyJobs.mockReset().mockResolvedValue(undefined);
  mocks.writeSystemLog.mockReset().mockResolvedValue(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the Worker backstop: what Astro answers before the middleware', () => {
  it.each([
    [
      'the origin check’s cross-site 403',
      403,
      'Cross-site POST form submissions are forbidden',
      {},
    ],
    ['the 400 for a multiply-encoded path', 400, null, {}],
    ['the duplicate-slash 301', 301, 'Redirecting to: /about/', { location: '/about/' }],
    ['a bare 500', 500, null, {}],
  ])('%s leaves with the headers', async (_what, status, body, headers) => {
    mocks.handle.mockResolvedValueOnce(new Response(body, { status, headers }));
    const res = await run('/about');
    expect(res.status).toBe(status);
    expectSecured(res);
    if ('location' in headers) expect(res.headers.get('location')).toBe(headers.location);
  });

  it('passes a response the middleware secured through as the same object', async () => {
    const page = new Response('<p>ok</p>', {
      headers: {
        ...STATIC_SECURITY_HEADERS,
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'nonce-bWlkZGxld2FyZQ=='",
      },
    });
    mocks.handle.mockResolvedValueOnce(page);
    const res = await run('/');
    expect(res).toBe(page);
    expect(res.headers.get('Content-Security-Policy')).toContain("'nonce-bWlkZGxld2FyZQ=='");
  });

  it('leaves a static file that public/_headers already secured unchanged', async () => {
    const asset = new Response('body{}', {
      headers: {
        'content-type': 'text/css',
        ...STATIC_SECURITY_HEADERS,
        'Content-Security-Policy': ASSET_CSP,
      },
    });
    mocks.handle.mockResolvedValueOnce(asset);
    const res = await run('/media/hero-poster-blur.jpg');
    expect(res).toBe(asset);
    expect(res.headers.get('Content-Security-Policy')).toBe(ASSET_CSP);
  });

  it('hands request, env and ctx to the adapter unchanged', async () => {
    mocks.handle.mockResolvedValueOnce(new Response('ok'));
    const env = { ASSETS: fakeAssets() };
    const ctx = fakeCtx();
    const request = new Request(`${ORIGIN}/contact`);
    await worker.fetch(request as never, env as never, ctx as never);
    expect(mocks.handle).toHaveBeenCalledTimes(1);
    expect(mocks.handle).toHaveBeenCalledWith(request, env, ctx);
  });
});

describe('the /media route', () => {
  it('answers /media/*.mp4 itself — never calls the adapter — with ONE policy and HSTS', async () => {
    const res = await run('/media/showreel.mp4', { headers: { range: 'bytes=0-9' } });
    expect(res.status).toBe(206);
    expect(mocks.handle).not.toHaveBeenCalled();
    expectSecured(res);
  });
});

describe('a thrown error', () => {
  it('in production: a secured, uncached text/plain 500, logged with the message scrubbed', async () => {
    vi.stubEnv('DEV', false);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.handle.mockRejectedValueOnce(new Error('render failed for jane@example.com'));
    const ctx = fakeCtx();
    const res = await run('/about', undefined, { ASSETS: fakeAssets() }, ctx);

    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('Internal Server Error');
    expectSecured(res);

    // Workers Logs get the stack, scrubbed exactly as the system_logs copy is.
    expect(consoleError).toHaveBeenCalledTimes(1);
    const logged = consoleError.mock.calls[0]!.map(String).join(' ');
    expect(logged).toContain('[worker] unhandled error Error: render failed for [email]');
    expect(logged).not.toContain('jane@example.com');
    expect(mocks.writeSystemLog).toHaveBeenCalledWith({
      level: 'error',
      source: 'worker',
      message: 'render failed for [email]',
    });
    // Handed to waitUntil: the log write never holds the 500 up.
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    expect(ctx.waitUntil.mock.calls[0]![0]).toBe(mocks.writeSystemLog.mock.results[0]!.value);
  });

  it('logs "unhandled error" for an empty message, and a throw from the media route too', async () => {
    vi.stubEnv('DEV', false);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const assets = { fetch: vi.fn().mockRejectedValue(new Error('')) };
    const res = await run('/media/showreel.mp4', undefined, { ASSETS: assets as never });
    expect(res.status).toBe(500);
    expectSecured(res);
    expect(mocks.handle).not.toHaveBeenCalled();
    expect(mocks.writeSystemLog).toHaveBeenCalledWith({
      level: 'error',
      source: 'worker',
      message: 'unhandled error',
    });
  });

  it('scrubs a thrown non-Error the same way, in both logs', async () => {
    vi.stubEnv('DEV', false);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.handle.mockRejectedValueOnce('lookup failed for +966 55 123 4567');
    const res = await run('/contact');
    expect(res.status).toBe(500);
    expect(consoleError).toHaveBeenCalledWith(
      '[worker] unhandled error',
      'lookup failed for [phone]',
    );
    expect(mocks.writeSystemLog).toHaveBeenCalledWith({
      level: 'error',
      source: 'worker',
      message: 'lookup failed for [phone]',
    });
  });

  it('caps the logged message at 500 characters', async () => {
    vi.stubEnv('DEV', false);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.handle.mockRejectedValueOnce(new Error('x'.repeat(5000)));
    await run('/about');
    const entry = mocks.writeSystemLog.mock.calls[0]![0] as { message: string };
    expect(entry.message).toHaveLength(500);
  });

  it('under astro dev (DEV, vitest’s default): rethrown as is, nothing logged', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new Error('boom');
    mocks.handle.mockRejectedValueOnce(boom);
    await expect(run('/about')).rejects.toBe(boom);
    expect(consoleError).not.toHaveBeenCalled();
    expect(mocks.writeSystemLog).not.toHaveBeenCalled();
  });
});

describe('scheduled', () => {
  it('hands the daily jobs to waitUntil', async () => {
    const ctx = fakeCtx();
    await worker.scheduled({} as never, {} as never, ctx as never);
    expect(mocks.runDailyJobs).toHaveBeenCalledTimes(1);
    expect(ctx.waitUntil).toHaveBeenCalledWith(mocks.runDailyJobs.mock.results[0]!.value);
  });
});
