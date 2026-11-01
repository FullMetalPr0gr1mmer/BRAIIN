import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TIER_A_CACHE_CONTROL } from '@/lib/http/cacheTags';
import { clearVisibilityMemo } from '@/lib/http/visibility';
import { __kv } from '../stubs/cloudflare-workers';

// The middleware and the theme (Admin v2 E4). A public page route answered to a GET starts the
// active theme's read ONCE, before the render, so it overlaps the page's own reads and the
// layout awaits the same promise (`locals.theme`): the theme costs the page no round trip of
// its own. The admin (a preview reads it in its own scope; AdminLayout reads it itself), the
// API, other methods and the routes that are files (the sitemap, robots.txt, llms.txt, and the
// stylesheet itself, which reads it on its own) start nothing.
//
// A read that FAILED (refused or unreachable: the page rendered without the theme's link) keeps
// the page out of the edge cache, so a blip never sticks to a Tier A page for a year; "no
// theme" is an answer like any other and leaves the page cacheable (E4 code review CR1).

const read = vi.hoisted(() => ({
  calls: 0,
  locals: [] as unknown[],
  answer: { theme: null, failed: false } as { theme: unknown; failed: boolean },
}));
vi.mock('@/lib/data/theme', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getThemeAnswer: (locals: { theme?: Promise<unknown> }) => {
    read.calls += 1;
    read.locals.push(locals);
    locals.theme ??= Promise.resolve(read.answer);
    return locals.theme;
  },
}));
vi.mock('@/lib/http/maintenanceBypass', () => ({ staffMayBypass: async () => false }));
vi.mock('@/lib/auth/session', () => ({
  createSessionClient: () => ({}),
  clearSessionCookies: () => undefined,
  HOST_COOKIE_BASE: {},
}));
vi.mock('@/lib/auth/context', () => ({
  resolveAuthContext: async () => ({ ctx: null, revoke: false }),
}));

const { onRequest } = await import('@/middleware');

type Next = (payload?: unknown) => Promise<Response>;
type Handler = (context: unknown, next: Next) => Promise<Response>;
const run = onRequest as unknown as Handler;

function context(path: string, routePattern: string, method = 'GET') {
  const url = new URL(`https://www.example.test${path}`);
  return {
    request: new Request(url, { method }),
    url,
    routePattern,
    locals: {} as Record<string, unknown>,
    cookies: { get: () => undefined, set: () => undefined, delete: () => undefined },
    redirect: (to: string, status = 302) =>
      new Response(null, { status, headers: { Location: to } }),
  };
}

const page: Next = async () =>
  new Response('<html><body>page</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

beforeEach(() => {
  __kv.clear();
  clearVisibilityMemo();
  read.calls = 0;
  read.locals = [];
  read.answer = { theme: null, failed: false };
});

describe('the theme read the middleware starts', () => {
  it.each([
    ['/', '/'],
    ['/about', '/about'],
    ['/ar/services/logo', '/ar/services/[slug]'],
    ['/no-such-page', ''],
  ])(
    'a public page (%s): once, on the request’s own locals, before the render',
    async (path, route) => {
      const ctx = context(path, route);
      let startedBeforeRender = false;
      await run(ctx, async () => {
        startedBeforeRender = read.calls === 1;
        return page();
      });
      expect(startedBeforeRender).toBe(true);
      expect(read.calls).toBe(1);
      expect(read.locals[0]).toBe(ctx.locals);
      expect(ctx.locals['theme']).toBeInstanceOf(Promise);
    },
  );

  it.each([
    ['/admin/appearance/theme', '/admin/appearance/theme', 'GET'],
    ['/admin/preview/about', '/admin/preview/[...path]', 'GET'],
    ['/api/search', '/api/search', 'GET'],
    ['/sitemap.xml', '/sitemap.xml', 'GET'],
    ['/robots.txt', '/robots.txt', 'GET'],
    ['/llms.txt', '/llms.txt', 'GET'],
    ['/styles/theme.css?v=0123456789abcdef', '/styles/theme.css', 'GET'],
    ['/contact', '/contact', 'POST'],
  ])('%s (%s, %s): nothing', async (path, route, method) => {
    await run(context(path, route, method), page).catch(() => undefined);
    expect(read.calls).toBe(0);
  });
});

describe('a page rendered while the theme read failed (CR1)', () => {
  const TIER_A = TIER_A_CACHE_CONTROL;
  const tierAPage: Next = async () =>
    new Response('<html><body>page</body></html>', {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'Cache-Control': TIER_A,
        'Cache-Tag': 'tenant:default,site:chrome,route:about,locale:en',
      },
    });

  it('is never edge-cached: private, no-store, no cache tag', async () => {
    read.answer = { theme: null, failed: true };
    const res = await run(context('/about', '/about'), tierAPage);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Cache-Tag')).toBeNull();
  });

  it.each([
    ['no theme', { theme: null, failed: false }],
    ['a theme', { theme: { tokens: {}, css: ':root{}', hash: '0123456789abcdef' }, failed: false }],
  ])('%s: the page keeps its Tier A headers', async (_name, answer) => {
    read.answer = answer;
    const res = await run(context('/about', '/about'), tierAPage);
    expect(res.headers.get('Cache-Control')).toBe(TIER_A);
    expect(res.headers.get('Cache-Tag')).toBe('tenant:default,site:chrome,route:about,locale:en');
  });
});
