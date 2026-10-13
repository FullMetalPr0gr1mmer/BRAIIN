import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MAINTENANCE_KV_KEY } from '@/lib/http/maintenance';
import { isImageEndpoint } from '@/lib/http/imageGuard';
import { storageThumbUrl } from '@/lib/media/storageUrl';
import { __kv } from '../stubs/cloudflare-workers';

// The `/_image` guard in the middleware (H3, widened to uploads by Admin v2 U3), keyed on
// the ROUTE, not the spelling. Astro matches routes on the decoded path with the trailing
// slash ignored, so `/_image/`, `/%5Fimage` and `/_imag%65/` reach the image endpoint; the
// guard compared `url.pathname === '/_image'` and let each of them through to the adapter,
// which transforms any width, height, quality and fit it is given. And the image endpoint is
// not a page: maintenance must not 503 it (the admin's thumbnails of uploads go through it).

vi.mock('@/lib/auth/session', () => ({
  createSessionClient: () => ({}),
  clearSessionCookies: () => undefined,
  HOST_COOKIE_BASE: {},
}));
vi.mock('@/lib/auth/context', () => ({
  resolveAuthContext: async () => ({ ctx: null, revoke: false }),
}));

const { onRequest } = await import('@/middleware');

type Handler = (context: unknown, next: () => Promise<Response>) => Promise<Response>;
const run = onRequest as unknown as Handler;

/** A request as Astro hands it to the middleware: the URL as sent, and the matched route. */
function context(path: string, routePattern = '') {
  const url = new URL(`https://www.example.test${path}`);
  return {
    request: new Request(url),
    url,
    routePattern,
    locals: {},
    cookies: { get: () => undefined, set: () => undefined, delete: () => undefined },
    redirect: (to: string, status = 302) =>
      new Response(null, { status, headers: { Location: to } }),
  };
}

const rendered = vi.fn(async () => new Response('transformed', { status: 200 }));

const KEY =
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/33333333-3333-4333-8333-333333333333_1200x800.webp';
/** A transform the markup never emits: an unlisted width, a quality and a fit. */
const ABUSE = new URL(storageThumbUrl(KEY)!, 'https://x.test').search
  .replace('w=320', 'w=333')
  .concat('&q=1&fit=cover');
/** One the markup does emit (the admin thumbnail). */
const THUMB = new URL(storageThumbUrl(KEY)!, 'https://x.test').search;

beforeEach(() => {
  __kv.clear();
  rendered.mockClear();
});

describe('the /_image guard is keyed on the route, not the spelling', () => {
  const aliases = ['/_image', '/_image/', '/%5Fimage', '/%5fimage', '/_imag%65/', '//_image'];

  it.each(aliases)('%s with a transform the markup never emits is a 400', async (path) => {
    // As Astro routes it (the image endpoint), and with no route at all (the path alone).
    for (const route of ['/_image', '']) {
      const res = await run(context(`${path}${ABUSE}`, route), rendered);
      expect(res.status, `${path} route=${route || 'none'}`).toBe(400);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('content-security-policy')).toContain('nonce-');
    }
    expect(rendered).not.toHaveBeenCalled();
  });

  it('whatever the path says, the image route is guarded', async () => {
    const res = await run(context(`/anything${ABUSE}`, '/_image'), rendered);
    expect(res.status).toBe(400);
  });

  it('an admitted transform reaches the endpoint, on any alias', async () => {
    for (const path of aliases) {
      const res = await run(context(`${path}${THUMB}`, '/_image'), rendered);
      expect(res.status, path).toBe(200);
    }
    expect(rendered).toHaveBeenCalledTimes(aliases.length);
  });

  it('isImageEndpoint: the route, or the path as Astro decodes and normalises it', () => {
    for (const path of aliases) expect(isImageEndpoint('', path), path).toBe(true);
    expect(isImageEndpoint('/_image', '/whatever')).toBe(true);
    expect(isImageEndpoint(undefined, '/%255Fimage')).toBe(true);
    for (const path of ['/_images', '/x/_image', '/_image/x', '/', '/_IMAGE', '/%E0%A4%A']) {
      expect(isImageEndpoint('', path), path).toBe(false);
    }
  });
});

describe('maintenance and the image endpoint', () => {
  beforeEach(() => {
    __kv.set(MAINTENANCE_KV_KEY, JSON.stringify({ active: true, allowlist: [] }));
  });

  it('pages answer 503, the image endpoint does not (it is not a page)', async () => {
    expect((await run(context('/', '/'), rendered)).status).toBe(503);
    const image = await run(context(`/_image${THUMB}`, '/_image'), rendered);
    expect(image.status).toBe(200);
    expect(await image.text()).toBe('transformed');
  });

  it('the guard still applies during maintenance', async () => {
    expect((await run(context(`/_image/${ABUSE}`, '/_image'), rendered)).status).toBe(400);
  });
});
