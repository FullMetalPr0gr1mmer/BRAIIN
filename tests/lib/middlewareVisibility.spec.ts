import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAINTENANCE_KV_KEY } from '@/lib/http/maintenance';
import {
  VISIBILITY_KV_KEY,
  clearVisibilityMemo,
  isListed,
  type VisibilitySnapshot,
} from '@/lib/http/visibility';
import {
  GATED_ROUTES,
  PAGE_PATHS,
  VISIBILITY_TEMPLATES,
  targetForRoute,
} from '@/lib/visibility/routes';
import { mintAccessCookie, pageAccessCookieName } from '@/lib/visibility/access';
import { pageAccess } from '@/lib/visibility/scope';
import { env, __kv } from '../stubs/cloudflare-workers';

// The middleware's page-visibility gate (Admin v2 U14a). A hidden page answers before the
// render (the render is never called for a 302, and the 404 is a rewrite to the 404 page),
// `private, no-store` and noindex, through `secured()` like every other response; link only
// renders with noindex; maintenance still wins; the admin, the API, the health probe and the
// image endpoint are never gated; and with no rows, or with rows for other pages, every gated
// route renders exactly as before, headers and all.
//
// The admin branches are not exercised here (they need a session client); both auth modules
// are mocked so importing the middleware pulls in no Supabase client.

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
const TIER_A = 'public, s-maxage=31536000, stale-while-revalidate=86400';

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

/** A `next` that records how it was called and answers like the page (or the 404 page). */
function page(status = 200) {
  const calls: unknown[] = [];
  const next: Next = async (payload) => {
    calls.push(payload);
    if (payload === '/404' || payload === '/ar/404') {
      return new Response(`<html><body>404 ${String(payload)}</body></html>`, {
        status: 404,
        headers: { ...HTML, 'cache-control': 'private, no-store' },
      });
    }
    return new Response('<html><body>page</body></html>', {
      status,
      headers: { ...HTML, 'cache-control': TIER_A, 'cache-tag': 'route:about,tenant:default' },
    });
  };
  return { next, calls };
}

function setSnapshot(
  pages: VisibilitySnapshot['pages'],
  templates: VisibilitySnapshot['templates'] = {},
  tenant: string | undefined = TENANT,
) {
  __kv.set(
    VISIBILITY_KV_KEY,
    JSON.stringify({ v: 1, builtAt: null, pages, templates, ...(tenant ? { tenant } : {}) }),
  );
  clearVisibilityMemo();
}

/** The tenant and page a password entry names, as a save would write them (U14b). */
const TENANT = '11111111-1111-4111-8111-111111111111';
const PAGE_ID = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const ROOT_KEY = 'test-dummy-lead-pii-enc-key';
const locked = (over: Record<string, unknown> = {}) => ({
  about: { mode: 'password' as const, id: PAGE_ID, pv: 3, ...over },
});

beforeEach(() => {
  __kv.clear();
  clearVisibilityMemo();
});

describe('middleware: a hidden page', () => {
  it('redirects (302, never 301) before the render, private, no-store and noindex, secured', async () => {
    setSnapshot({ about: { mode: 'hidden', target: 'contact' } });
    const { next, calls } = page();
    const res = await run(context('/about', '/about'), next);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/contact');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('cache-tag')).toBeNull();
    expect(res.headers.get('content-security-policy')).toContain('nonce-');
    expect(res.headers.get('strict-transport-security')).toContain('max-age');
    expect(calls).toEqual([]);
  });

  it('sends an Arabic visitor to the Arabic twin, by the route that matched', async () => {
    setSnapshot({ about: { mode: 'hidden', target: 'home' } });
    const res = await run(context('/ar/about', '/ar/about'), page().next);
    expect(res.headers.get('location')).toBe('/ar');
    const en = await run(context('/about/', '/about'), page().next);
    expect(en.headers.get('location')).toBe('/');
  });

  it('with no target renders the 404 page through a rewrite: its status, never cached', async () => {
    setSnapshot({ join: { mode: 'hidden', target: null } });
    const en = page();
    const res = await run(context('/join', '/join'), en.next);
    expect(en.calls).toEqual(['/404']);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('404 /404');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    const ar = page();
    const arRes = await run(context('/ar/join', '/ar/join'), ar.next);
    expect(ar.calls).toEqual(['/ar/404']);
    expect(arRes.status).toBe(404);
  });

  it('is gated by the route, so an encoded or doubled path to it is gated too', async () => {
    setSnapshot({ about: { mode: 'hidden', target: null } });
    for (const path of ['/abo%75t', '/about/', '//about', '/x/../about']) {
      const { next, calls } = page();
      const res = await run(context(path, '/about'), next);
      expect(res.status, path).toBe(404);
      expect(calls, path).toEqual(['/404']);
    }
  });

  it('answers every method alike: a hidden page answers nothing', async () => {
    setSnapshot({ about: { mode: 'hidden', target: 'contact' } });
    for (const method of ['HEAD', 'POST', 'PUT', 'DELETE']) {
      const { next, calls } = page();
      const res = await run(context('/about', '/about', method), next);
      expect(res.status, method).toBe(302);
      expect(calls, method).toEqual([]);
    }
  });

  it('a redirect to a page that is hidden too is a 404, never a chain', async () => {
    setSnapshot({
      about: { mode: 'hidden', target: 'join' },
      join: { mode: 'hidden', target: 'about' },
    });
    const { next, calls } = page();
    expect((await run(context('/about', '/about'), next)).status).toBe(404);
    expect(calls).toEqual(['/404']);
  });

  it('a hidden template hides every page it renders, never its listing page', async () => {
    setSnapshot({}, { service: { mode: 'hidden', target: null } });
    const detail = page();
    expect((await run(context('/services/logo', '/services/[slug]'), detail.next)).status).toBe(
      404,
    );
    expect(
      (await run(context('/ar/services/logo', '/ar/services/[slug]'), page().next)).status,
    ).toBe(404);
    const listing = await run(context('/services', '/services'), page().next);
    expect(listing.status).toBe(200);
    expect(listing.headers.get('x-robots-tag')).toBeNull();
    const project = await run(context('/portfolio/the-rider', '/portfolio/[slug]'), page().next);
    expect(project.status).toBe(200);
  });

  it('inside its window only', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    setSnapshot({ about: { mode: 'hidden', target: null, from: future } });
    expect((await run(context('/about', '/about'), page().next)).status).toBe(200);
    const past = new Date(Date.now() - 86_400_000).toISOString();
    setSnapshot({ about: { mode: 'hidden', target: null, until: past } });
    expect((await run(context('/about', '/about'), page().next)).status).toBe(200);
  });
});

describe('middleware: link only', () => {
  it('renders as usual, Tier A, with noindex', async () => {
    setSnapshot({ about: { mode: 'link' } });
    const { next, calls } = page();
    const res = await run(context('/about', '/about'), next);
    expect(res.status).toBe(200);
    expect(calls).toEqual([undefined]);
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('cache-control')).toBe(TIER_A);
  });
});

describe('middleware: what the gate leaves alone', () => {
  it('maintenance still answers first', async () => {
    __kv.set(MAINTENANCE_KV_KEY, JSON.stringify({ active: true, allowlist: [] }));
    setSnapshot({ about: { mode: 'hidden', target: 'contact' } });
    const res = await run(context('/about', '/about'), page().next);
    expect(res.status).toBe(503);
  });

  it('the homepage renders whatever the snapshot says', async () => {
    setSnapshot({ home: { mode: 'hidden', target: null } } as VisibilitySnapshot['pages']);
    expect((await run(context('/', '/'), page().next)).status).toBe(200);
    expect((await run(context('/ar', '/ar'), page().next)).status).toBe(200);
  });

  it('never gates the API, the admin or the health probe', async () => {
    setSnapshot({ about: { mode: 'hidden', target: null } });
    for (const [path, route] of [
      ['/api/search', '/api/search'],
      ['/healthz', '/healthz'],
    ] as const) {
      const res = await run(context(path, route), page().next);
      expect(res.status, path).toBe(200);
    }
    // An admin path named like a gated route is still the admin's (the session gate answers).
    const admin = await run(context('/admin/visibility', '/about'), page().next);
    expect(admin.status).toBe(302);
    expect(admin.headers.get('location')).toMatch(/^\/admin\/login/);
  });

  it('hands the snapshot to the page through locals, read once', async () => {
    setSnapshot({ about: { mode: 'link' } });
    const ctx = context('/contact', '/contact');
    await run(ctx, page().next);
    expect((ctx.locals['visibility'] as VisibilitySnapshot).pages.about?.mode).toBe('link');
  });

  it('fails open: an unreadable snapshot hides nothing', async () => {
    __kv.set(VISIBILITY_KV_KEY, '{{{');
    expect((await run(context('/about', '/about'), page().next)).status).toBe(200);
    const get = vi.spyOn(env.SESSION, 'get').mockRejectedValue(new Error('kv down'));
    clearVisibilityMemo();
    expect((await run(context('/about', '/about'), page().next)).status).toBe(200);
    get.mockRestore();
  });
});

describe('middleware: every gated route stays public with no rows, and with unrelated rows', () => {
  const renderOnce = async (path: string, route: string) => {
    const { next, calls } = page();
    const res = await run(context(path, route), next);
    return {
      status: res.status,
      calls,
      body: await res.text(),
      headers: [...res.headers.entries()].filter(
        ([name]) =>
          !['content-security-policy', 'content-security-policy-report-only'].includes(name),
      ),
    };
  };
  const pathOf = (route: string) => route.replace('[slug]', 'sample');

  it('no snapshot, an empty one, or one about other pages: the same response for each', async () => {
    const baseline = new Map<string, Awaited<ReturnType<typeof renderOnce>>>();
    for (const route of GATED_ROUTES) baseline.set(route, await renderOnce(pathOf(route), route));
    for (const result of baseline.values()) {
      expect(result.status).toBe(200);
      expect(result.calls).toEqual([undefined]);
      expect(result.headers.find(([n]) => n === 'x-robots-tag')).toBeUndefined();
    }

    setSnapshot({});
    for (const route of GATED_ROUTES) {
      expect(await renderOnce(pathOf(route), route), route).toEqual(baseline.get(route));
    }

    // One route at a time: every OTHER page link only and every other template hidden, and
    // this route's response is its baseline, byte for byte, headers and all.
    for (const route of GATED_ROUTES) {
      const own = targetForRoute(route);
      expect(own, route).not.toBeNull();
      const pages = Object.fromEntries(
        Object.keys(PAGE_PATHS)
          .filter((slug) => slug !== 'home' && !(own?.kind === 'page' && own.slug === slug))
          .map((slug) => [slug, { mode: 'link' as const }]),
      );
      const templates = Object.fromEntries(
        VISIBILITY_TEMPLATES.filter(
          (template) => !(own?.kind === 'template' && own.template === template),
        ).map((template) => [template, { mode: 'hidden' as const, target: null }]),
      );
      setSnapshot(pages, templates);
      expect(await renderOnce(pathOf(route), route), route).toEqual(baseline.get(route));
    }
    setSnapshot({ join: { mode: 'hidden', target: null } });
    for (const route of GATED_ROUTES.filter((r) => !/\/join$/.test(r))) {
      expect(await renderOnce(pathOf(route), route), route).toEqual(baseline.get(route));
    }
    setSnapshot({}, { case_study: { mode: 'hidden', target: null } });
    for (const route of GATED_ROUTES.filter((r) => !r.endsWith('/portfolio/[slug]'))) {
      expect(await renderOnce(pathOf(route), route), route).toEqual(baseline.get(route));
    }
  });
});

describe('middleware: a page behind a password (U14b)', () => {
  it('answers the gate before the render: 403, private, no-store, noindex, no cache tag', async () => {
    setSnapshot(locked({ note: { en: 'Ask the studio.' } }));
    const { next, calls } = page();
    const res = await run(context('/about', '/about'), next);
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('cache-tag')).toBeNull();
    // Secured like every other answer: the nonce in the CSP is the one the page carries.
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('nonce-');
    const html = await res.text();
    expect(html).toContain('Ask the studio.');
    const nonce = /nonce-([A-Za-z0-9+/=]+)/.exec(csp)?.[1];
    expect(html).toContain(`<style nonce="${nonce}">`);
  });

  it('the Arabic twin gets the Arabic gate, by the route that matched', async () => {
    setSnapshot(locked());
    const res = await run(context('/ar/about', '/ar/about'), page().next);
    const html = await res.text();
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain('value="/ar/about"');
  });

  it('with the page’s own cookie it renders, private, no-store, noindex, inside the scope', async () => {
    setSnapshot(locked());
    const value = await mintAccessCookie(ROOT_KEY, { pageId: PAGE_ID, pv: 3 });
    const seen: (string | undefined)[] = [];
    const next = async () => {
      seen.push(pageAccess()?.pageId, pageAccess()?.tenantId);
      return new Response('<html><body>page</body></html>', {
        status: 200,
        headers: { ...HTML, 'cache-control': TIER_A, 'cache-tag': 'route:about' },
      });
    };
    const res = await run(
      context('/about', '/about', 'GET', { name: pageAccessCookieName(PAGE_ID), value }),
      next as never,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('page');
    // The render saw which page it was allowed to read, and for which tenant.
    expect(seen).toEqual([PAGE_ID, TENANT]);
    // And the answer is never cached and never indexed.
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('cache-tag')).toBeNull();
  });

  it('another page’s cookie, an older version and a forged one all get the gate', async () => {
    setSnapshot(locked());
    const name = pageAccessCookieName(PAGE_ID);
    const other = await mintAccessCookie(ROOT_KEY, { pageId: PAGE_ID, pv: 2 });
    for (const value of [other, 'not-a-cookie', `${other}x`]) {
      const res = await run(context('/about', '/about', 'GET', { name, value }), page().next);
      expect(res.status, value.slice(0, 12)).toBe(403);
    }
  });

  it('gates every method, not only GET: a closed page answers nothing', async () => {
    setSnapshot(locked());
    for (const method of ['GET', 'HEAD', 'POST']) {
      const { next, calls } = page();
      const res = await run(context('/about', '/about', method), next);
      expect(res.status, method).toBe(403);
      expect(calls).toEqual([]);
    }
  });

  it('says a try failed when the unlock route sent the visitor back, echoing nothing', async () => {
    setSnapshot(locked());
    const res = await run(context('/about?pa=wrong', '/about'), page().next);
    const html = await res.text();
    expect(html).toContain('That password did not work.');
    const clean = await (await run(context('/about', '/about'), page().next)).text();
    expect(clean).not.toContain('That password did not work.');
  });

  it('a password entry whose id or version cannot be read 404s: never a public page', async () => {
    const { next, calls } = page();
    setSnapshot({ about: { mode: 'password' } } as never);
    const res = await run(context('/about', '/about'), next);
    expect(res.status).toBe(404);
    expect(calls).toEqual(['/404']);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('maintenance still wins: the 503 comes before the password box', async () => {
    __kv.set(MAINTENANCE_KV_KEY, JSON.stringify({ active: true, allowlist: [] }));
    setSnapshot(locked());
    const res = await run(context('/about', '/about'), page().next);
    expect(res.status).toBe(503);
  });

  it('a password page is not listed anywhere a public one is', () => {
    const snap = {
      v: 1 as const,
      builtAt: null,
      pages: locked(),
      templates: {},
    };
    expect(targetForRoute('/about')).toEqual({ kind: 'page', slug: 'about' });
    expect(isListed(snap, targetForRoute('/about'), Date.now())).toBe(false);
  });
});
