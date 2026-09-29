import { describe, it, expect, beforeEach, vi } from 'vitest';
import { REDIRECTS_KV_KEY, REDIRECT_CACHE_CONTROL } from '@/lib/http/redirects';
import { env, __kv } from '../stubs/cloudflare-workers';

// The middleware's redirect placement (Round 3, design-port R3-1): an authored rule
// answers ONLY where the render answered 404, never over a page that exists, never on
// /api, /healthz or a mutation — and the 30x leaves through `secured()` like every
// other response, so it carries the CSP and HSTS a redirect hop needs most.
//
// The admin branches are not exercised here (they need a session client); both auth
// modules are mocked so importing the middleware pulls in no Supabase client.

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

const HTML = { 'content-type': 'text/html; charset=utf-8' };

function context(path: string, method = 'GET') {
  const url = new URL(`https://www.example.test${path}`);
  return {
    request: new Request(url, { method }),
    url,
    locals: {},
    cookies: { get: () => undefined, set: () => undefined, delete: () => undefined },
    redirect: (to: string, status = 302) =>
      new Response(null, { status, headers: { Location: to } }),
  };
}

const render = (status: number) => async () =>
  new Response(`<html><body>${status}</body></html>`, { status, headers: HTML });

beforeEach(() => {
  __kv.clear();
  __kv.set(
    REDIRECTS_KV_KEY,
    JSON.stringify({
      '/old': { to: '/about', status: 301 },
      '/moved': { to: '/portfolio', status: 308 },
      '/healthz': { to: '/evil', status: 301 },
      '/api/x': { to: '/evil', status: 301 },
    }),
  );
});

describe('middleware — authored redirects after a 404', () => {
  it('a 404 render with a rule becomes the rule’s 30x, with headers from secured()', async () => {
    const res = await run(context('/old'), render(404));
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/about');
    expect(res.headers.get('cache-control')).toBe(REDIRECT_CACHE_CONTROL);
    expect(res.headers.get('content-security-policy')).toContain('nonce-');
    expect(res.headers.get('strict-transport-security')).toContain('max-age');
  });

  it('keeps the rule’s status and carries the request query', async () => {
    const res = await run(context('/moved?utm=x'), render(404));
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('/portfolio?utm=x');
  });

  it('the /ar twin of an English rule redirects to the Arabic target', async () => {
    const res = await run(context('/ar/old'), render(404));
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/ar/about');
  });

  it('a page that renders is never shadowed by a rule — live page wins', async () => {
    const res = await run(context('/old'), render(200));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('does not read the redirect map at all when the render is not a 404', async () => {
    const get = vi.spyOn(env.SESSION, 'get');
    await run(context('/old'), render(200));
    expect(get.mock.calls.map((c) => c[0])).not.toContain(REDIRECTS_KV_KEY);
    get.mockRestore();
  });

  it('a 404 with no rule stays a 404', async () => {
    const res = await run(context('/nothing-here'), render(404));
    expect(res.status).toBe(404);
  });

  it('/api/* and /healthz are never redirected, even with a (dropped) rule', async () => {
    expect((await run(context('/api/x'), render(404))).status).toBe(404);
    expect((await run(context('/healthz'), render(404))).status).toBe(404);
  });

  it('a POST that 404s is not redirected', async () => {
    expect((await run(context('/old', 'POST'), render(404))).status).toBe(404);
  });

  it('HEAD is redirected like GET', async () => {
    const res = await run(context('/old', 'HEAD'), render(404));
    expect(res.status).toBe(301);
  });

  it('fails open when the map is unreadable', async () => {
    __kv.set(REDIRECTS_KV_KEY, '{{{');
    expect((await run(context('/old'), render(404))).status).toBe(404);
  });
});
