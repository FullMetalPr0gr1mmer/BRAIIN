import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAINTENANCE_DEFAULTS } from '@schemas/maintenance';
import { MAINTENANCE_KV_KEY } from '@/lib/http/maintenance';
import { GA4_CSP_SOURCES } from '@/lib/http/securityHeaders';
import {
  HIDDEN_CACHE_CONTROL,
  VISIBILITY_KV_KEY,
  clearVisibilityMemo,
} from '@/lib/http/visibility';
import { mintAccessCookie, pageAccessCookieName } from '@/lib/visibility/access';
import { __kv } from '../stubs/cloudflare-workers';

// The middleware's GA4 step (Admin v2 U15): with the switch off, nothing is read and every
// response is the one it was; with it on, a public page route answered publicly reads the id
// ONCE, before the render (so it overlaps the page's reads), hands the promise to the layout
// in `locals.ga4`, and lists Google's hosts in the CSP of an HTML answer only when the read
// found an id. The admin, the API, other routes, other methods and private answers never read.

const flag = vi.hoisted(() => ({ on: false }));
vi.mock('astro:env/server', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const mocked = { ...real };
  Object.defineProperty(mocked, 'GA4_NOTICE_READY', { get: () => flag.on, enumerable: true });
  return mocked;
});
const read = vi.hoisted(() => ({ id: 'G-ABC123XYZ' as string | null, calls: 0 }));
vi.mock('@/lib/data/ga4', () => ({
  getGa4MeasurementId: async () => {
    read.calls += 1;
    return read.id;
  },
}));
const bypass = vi.hoisted(() => ({ result: false }));
vi.mock('@/lib/http/maintenanceBypass', () => ({ staffMayBypass: async () => bypass.result }));
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

const HTML = { 'content-type': 'text/html; charset=utf-8' };

function context(
  path: string,
  routePattern: string | undefined,
  method = 'GET',
  cookie?: { name: string; value: string },
) {
  const url = new URL(`https://www.example.test${path}`);
  return {
    request: new Request(url, { method }),
    url,
    routePattern,
    locals: {} as Record<string, unknown>,
    cookies: {
      get: (name: string) => (cookie && cookie.name === name ? { value: cookie.value } : undefined),
      set: () => undefined,
      delete: () => undefined,
    },
    redirect: (to: string, status = 302) =>
      new Response(null, { status, headers: { Location: to } }),
  };
}

const csp = (res: Response) => res.headers.get('content-security-policy') ?? '';
const google = (res: Response) => /google/.test(csp(res));

/** One request; `seen` is what the layout would find in `locals` when the render begins. */
async function visit(
  path: string,
  route: string | undefined,
  method = 'GET',
  headers: Record<string, string> = HTML,
  cookie?: { name: string; value: string },
) {
  const ctx = context(path, route, method, cookie);
  const seen: { ga4: unknown; readsBefore: number }[] = [];
  const next: Next = async () => {
    seen.push({ ga4: ctx.locals['ga4'], readsBefore: read.calls });
    return new Response('<html><body>page</body></html>', { status: 200, headers });
  };
  const res = await run(ctx, next);
  return { res, ctx, seen };
}

beforeEach(() => {
  __kv.clear();
  clearVisibilityMemo();
  flag.on = false;
  read.id = 'G-ABC123XYZ';
  read.calls = 0;
  bypass.result = false;
});

describe('the switch off (every production build until the notice is signed off)', () => {
  it('reads nothing and lists no Google host, on every page route, an id saved or not', async () => {
    for (const [path, route] of [
      ['/', '/'],
      ['/ar', '/ar'],
      ['/services/logo', '/services/[slug]'],
      ['/ar/about', '/ar/about'],
    ] as const) {
      const { res, ctx, seen } = await visit(path, route);
      expect(read.calls, path).toBe(0);
      expect(ctx.locals['ga4'], path).toBeUndefined();
      expect(seen[0]?.ga4, path).toBeUndefined();
      expect(google(res), path).toBe(false);
    }
  });
});

describe('the switch on', () => {
  beforeEach(() => {
    flag.on = true;
  });

  it('reads once, before the render, and lists exactly the GA4 hosts when an id is saved', async () => {
    const { res, seen } = await visit('/about', '/about');
    expect(read.calls).toBe(1);
    expect(seen[0]?.readsBefore).toBe(1);
    expect(await (seen[0]?.ga4 as Promise<string | null>)).toBe('G-ABC123XYZ');
    const policy = csp(res);
    for (const [directive, sources] of [
      ['script-src', GA4_CSP_SOURCES.script],
      ['connect-src', GA4_CSP_SOURCES.connect],
      ['img-src', GA4_CSP_SOURCES.img],
    ] as const) {
      const listed = policy
        .split(';')
        .map((d) => d.trim())
        .find((d) => d.startsWith(`${directive} `));
      for (const source of sources) expect(listed, `${directive} ${source}`).toContain(source);
    }
    expect(policy).not.toContain("'unsafe-inline'");
    expect(res.headers.get('strict-transport-security')).toContain('max-age');
  });

  it('in Arabic too, and on a template route', async () => {
    for (const [path, route] of [
      ['/ar', '/ar'],
      ['/ar/portfolio/some-project', '/ar/portfolio/[slug]'],
      ['/creative-knowledge/a-post', '/creative-knowledge/[slug]'],
    ] as const) {
      const { res } = await visit(path, route);
      expect(google(res), path).toBe(true);
    }
    expect(read.calls).toBe(3);
  });

  it('with no id saved: one read, and the policy without Google', async () => {
    read.id = null;
    const { res, seen } = await visit('/', '/');
    expect(read.calls).toBe(1);
    expect(await (seen[0]?.ga4 as Promise<string | null>)).toBeNull();
    expect(google(res)).toBe(false);
  });

  it('a HEAD reads too, so its headers are the GET answer’s', async () => {
    const { res } = await visit('/about', '/about', 'HEAD');
    expect(google(res)).toBe(true);
  });

  it('an answer that is not HTML never lists Google, though the route read', async () => {
    const { res } = await visit('/services', '/services', 'GET', {
      'content-type': 'application/json',
    });
    expect(read.calls).toBe(1);
    expect(google(res)).toBe(false);
  });

  it('never reads for the admin, the API, search, Join, Contact, an endpoint or a write', async () => {
    for (const [path, route, method] of [
      ['/join', '/join', 'GET'],
      ['/ar/join', '/ar/join', 'GET'],
      ['/contact', '/contact', 'GET'],
      ['/ar/contact', '/ar/contact', 'GET'],
      ['/admin', '/admin', 'GET'],
      ['/admin/integrations', '/admin/integrations', 'GET'],
      ['/api/contact', '/api/contact', 'POST'],
      ['/api/search', '/api/search', 'GET'],
      ['/search', '/search', 'GET'],
      ['/ar/search', '/ar/search', 'GET'],
      ['/sitemap.xml', '/sitemap.xml', 'GET'],
      ['/healthz', '/healthz', 'GET'],
      ['/contact', '/contact', 'POST'],
      ['/nowhere', undefined, 'GET'],
    ] as const) {
      const { res, ctx } = await visit(path, route, method);
      expect(ctx.locals['ga4'], `${method} ${path}`).toBeUndefined();
      expect(google(res), `${method} ${path}`).toBe(false);
    }
    expect(read.calls).toBe(0);
  });

  it('never for a page a signed-in person sees past the maintenance page (a private answer)', async () => {
    __kv.set(
      MAINTENANCE_KV_KEY,
      JSON.stringify({ ...MAINTENANCE_DEFAULTS, v: 2, active: true, staffBypass: true }),
    );
    bypass.result = true;
    const { res, ctx } = await visit('/about', '/about');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(ctx.locals['ga4']).toBeUndefined();
    expect(google(res)).toBe(false);
    expect(read.calls).toBe(0);
  });

  it('never for a page unlocked by its password (a private answer)', async () => {
    // The page-visibility snapshot a password save writes (U14b; as middlewareVisibility.spec),
    // and the page's own valid access cookie: the page renders, privately, and loads no GA4.
    const tenant = '11111111-1111-4111-8111-111111111111';
    const pageId = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
    __kv.set(
      VISIBILITY_KV_KEY,
      JSON.stringify({
        v: 1,
        builtAt: null,
        pages: { about: { mode: 'password', id: pageId, pv: 3 } },
        templates: {},
        tenant,
      }),
    );
    clearVisibilityMemo();
    const value = await mintAccessCookie('test-dummy-lead-pii-enc-key', { pageId, pv: 3 });
    const { res, ctx, seen } = await visit('/about', '/about', 'GET', HTML, {
      name: pageAccessCookieName(pageId),
      value,
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(res.headers.get('cache-control')).toBe(HIDDEN_CACHE_CONTROL);
    expect(read.calls).toBe(0);
    expect(ctx.locals['ga4']).toBeUndefined();
    expect(seen[0]?.ga4).toBeUndefined();
    expect(google(res)).toBe(false);
  });

  it('nor for the maintenance page itself, which answers before the render', async () => {
    __kv.set(MAINTENANCE_KV_KEY, JSON.stringify({ ...MAINTENANCE_DEFAULTS, active: true }));
    const { res } = await visit('/', '/');
    expect(res.status).toBe(503);
    expect(google(res)).toBe(false);
    expect(read.calls).toBe(0);
  });
});
