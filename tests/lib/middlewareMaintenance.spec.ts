import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAINTENANCE_DEFAULTS, type MaintenanceSnapshot } from '@schemas/maintenance';
import { MAINTENANCE_KV_KEY } from '@/lib/http/maintenance';
import { REDIRECTS_KV_KEY } from '@/lib/http/redirects';
import { VISIBILITY_KV_KEY, clearVisibilityMemo } from '@/lib/http/visibility';
import { __kv } from '../stubs/cloudflare-workers';

// The middleware's maintenance pre-cache check, v2 (Admin v2 U9b): ONE KV value decides it.
// A visitor gets the 503 (bilingual by the route, Retry-After, no-store, the strict CSP); an
// allowed address passes; a signed-in person passes only when the value allows the bypass AND
// the admin's own session check passes (mocked here: tests/lib/maintenanceBypass.spec.ts proves
// the check itself), and that answer is private, untagged and noindex; anything else is the
// 503 (fail closed). /admin, /api, /healthz, /_image and the theme stylesheet (E4) are never
// gated, and the page visibility gate still runs after a bypass. "Back on" ends it at the
// instant.

const bypass = vi.hoisted(() => ({ result: true as boolean | 'throw', calls: 0 }));

vi.mock('@/lib/http/maintenanceBypass', () => ({
  staffMayBypass: async () => {
    bypass.calls += 1;
    if (bypass.result === 'throw') throw new Error('auth server down');
    return bypass.result;
  },
}));
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

const TIER_A = 'public, s-maxage=31536000, stale-while-revalidate=86400';

function context(path: string, routePattern: string | undefined, ip?: string) {
  const url = new URL(`https://www.example.test${path}`);
  return {
    request: new Request(url, { headers: ip ? { 'cf-connecting-ip': ip } : {} }),
    url,
    routePattern,
    locals: {} as Record<string, unknown>,
    cookies: { get: () => undefined, set: () => undefined, delete: () => undefined },
    redirect: (to: string, status = 302) =>
      new Response(null, { status, headers: { Location: to } }),
  };
}

function page() {
  const calls: unknown[] = [];
  const next: Next = async (payload) => {
    calls.push(payload);
    return new Response('<html><body>page</body></html>', {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': TIER_A,
        'cache-tag': 'route:about,tenant:default',
      },
    });
  };
  return { next, calls };
}

const set = (value: Partial<MaintenanceSnapshot> | Record<string, unknown>) =>
  __kv.set(MAINTENANCE_KV_KEY, JSON.stringify({ ...MAINTENANCE_DEFAULTS, ...value }));

beforeEach(() => {
  __kv.clear();
  clearVisibilityMemo();
  bypass.result = true;
  bypass.calls = 0;
});

describe('a visitor during maintenance', () => {
  it('gets the 503 before the render: Retry-After, no-store, the strict CSP, English', async () => {
    set({ active: true, staffBypass: false });
    const { next, calls } = page();
    const res = await run(context('/about', '/about'), next);
    expect(res.status).toBe(503);
    expect(calls).toEqual([]);
    expect(res.headers.get('retry-after')).toBe('3600');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toMatch(/style-src[^;]*'nonce-/);
    expect(res.headers.get('content-security-policy')).not.toContain("'unsafe-inline'");
    const html = await res.text();
    expect(html).toContain('<html lang="en" dir="ltr">');
    expect(html).toContain('We&#39;re making something new.');
  });

  it('on an Arabic route, in Arabic, right to left', async () => {
    set({ active: true, staffBypass: false });
    const res = await run(context('/ar/about', '/ar/about'), page().next);
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain('نجهّز شي جديد.');
  });

  it('with a "Back on" day: Retry-After counts down to it; at the instant the site is back', async () => {
    const untilAt = new Date(Date.now() + 5 * 3_600_000).toISOString();
    set({ active: true, staffBypass: false, until: '2099-01-01', untilAt, showDate: true });
    const res = await run(context('/', '/'), page().next);
    expect(res.status).toBe(503);
    const wait = Number(res.headers.get('retry-after'));
    expect(wait).toBeGreaterThan(5 * 3600 - 10);
    expect(wait).toBeLessThanOrEqual(5 * 3600);

    set({
      active: true,
      staffBypass: false,
      until: '2020-01-01',
      untilAt: new Date(Date.now() - 1000).toISOString(),
    });
    const back = await run(context('/', '/'), page().next);
    expect(back.status).toBe(200);
  });
});

describe('who passes', () => {
  it('an allowed address, compared in its canonical form', async () => {
    set({ active: true, staffBypass: false, allowlist: ['2001:db8::1'] });
    const res = await run(context('/about', '/about', '2001:DB8:0:0:0:0:0:1'), page().next);
    expect(res.status).toBe(200);
    expect(bypass.calls).toBe(0);
  });

  it('a signed-in person when the value allows it: private, no-store, no tag, noindex', async () => {
    set({ v: 2, active: true, staffBypass: true });
    const res = await run(context('/about', '/about'), page().next);
    expect(res.status).toBe(200);
    expect(bypass.calls).toBe(1);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('cache-tag')).toBeNull();
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
  });

  it('a signed-in person sent on by an authored redirect: the redirect is private too', async () => {
    set({ v: 2, active: true, staffBypass: true });
    __kv.set(REDIRECTS_KV_KEY, JSON.stringify({ '/old': { to: '/about', status: 301 } }));
    const missing: Next = async () =>
      new Response('<html><body>404</body></html>', { status: 404 });
    const res = await run(context('/old', undefined), missing);
    expect(bypass.calls).toBe(1);
    expect([res.status, res.headers.get('location')]).toEqual([301, '/about']);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('cache-tag')).toBeNull();
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
  });

  it('fails CLOSED: the check says no, or throws: the 503', async () => {
    set({ v: 2, active: true, staffBypass: true });
    bypass.result = false;
    expect((await run(context('/about', '/about'), page().next)).status).toBe(503);
    bypass.result = 'throw';
    expect((await run(context('/about', '/about'), page().next)).status).toBe(503);
  });

  it('with the bypass off, a signed-in person is not even checked: the 503', async () => {
    set({ v: 2, active: true, staffBypass: false });
    expect((await run(context('/about', '/about'), page().next)).status).toBe(503);
    expect(bypass.calls).toBe(0);
  });

  it('a value from before v2 (no staffBypass) never lets anyone past', async () => {
    __kv.set(MAINTENANCE_KV_KEY, JSON.stringify({ active: true, allowlist: [] }));
    expect((await run(context('/about', '/about'), page().next)).status).toBe(503);
    expect(bypass.calls).toBe(0);
  });

  it('the page visibility gate still runs after a bypass', async () => {
    set({ v: 2, active: true, staffBypass: true });
    __kv.set(
      VISIBILITY_KV_KEY,
      JSON.stringify({
        v: 1,
        builtAt: null,
        pages: { about: { mode: 'hidden', target: 'contact' } },
      }),
    );
    clearVisibilityMemo();
    const res = await run(context('/about', '/about'), page().next);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/contact');
  });
});

describe('never gated', () => {
  it.each([
    ['/admin', '/admin'],
    ['/api/admin/settings/maintenance', '/api/admin/settings/maintenance'],
    ['/healthz', '/healthz'],
    ['/_image?href=x&w=1&h=1&f=webp', '/_image'],
    // Admin v2 E4: the theme's custom properties, which every admin screen links.
    ['/styles/theme.css?v=0123456789abcdef', '/styles/theme.css'],
  ])('%s', async (path, route) => {
    set({ active: true, staffBypass: false });
    const res = await run(context(path, route), page().next);
    expect(res.status).not.toBe(503);
  });
});

describe('maintenance off', () => {
  it('a public page renders as before, cache headers and all', async () => {
    const res = await run(context('/about', '/about'), page().next);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(TIER_A);
    expect(res.headers.get('cache-tag')).toBe('route:about,tenant:default');
    expect(res.headers.get('x-robots-tag')).toBeNull();
    expect(bypass.calls).toBe(0);
  });
});
