import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/lib/auth/types';
import type { PendingSecondStep } from '@/lib/auth/twoStep';
import { CSRF_COOKIE_NAME, CSRF_FIELD_NAME, CSRF_HEADER_NAME } from '@/lib/http/csrf';

// The middleware's half of two-step sign-in (Admin v2 U17). A session that passed the password
// but still owes its code (or its setup) has no AuthContext, only `pending`
// (src/lib/auth/context.ts). It reaches /admin/2fa and sign-out, both read by the path AND the
// route Astro matched; every other admin page sends it to /admin/2fa, every admin API answers
// 401 `two-step-required`, before any body is read. It goes through the CSRF check like any
// session, and the two-step page's own refused form goes back to the page.

const state = vi.hoisted(() => ({
  auth: { ctx: null, revoke: false, pending: null } as {
    ctx: AuthContext | null;
    revoke: boolean;
    pending: PendingSecondStep | null;
  },
}));

vi.mock('@/lib/auth/context', () => ({ resolveAuthContext: async () => state.auth }));
vi.mock('@/lib/auth/session', () => ({
  createSessionClient: () => ({ auth: { signOut: async () => ({ error: null }) } }),
  clearSessionCookies: () => undefined,
  HOST_COOKIE_BASE: {},
}));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

const { onRequest } = await import('@/middleware');
type Handler = (context: unknown, next: () => Promise<Response>) => Promise<Response>;
const middleware = onRequest as unknown as Handler;

const ORIGIN = 'https://admin.example.test';
const TOKEN = 'b'.repeat(64);
const PENDING: PendingSecondStep = {
  userId: '11111111-1111-4111-8111-111111111111',
  tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'staff@example.test',
  role: 'content_creator',
  mode: 'challenge',
  factorId: '33333333-3333-4333-8333-333333333333',
};
const FULL: AuthContext = {
  userId: PENDING.userId,
  tenantId: PENDING.tenantId,
  role: 'content_creator',
  isActive: true,
  email: PENDING.email,
};

const staticRoute = (pathname: string): string =>
  pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname;

interface Options {
  method?: string;
  body?: string;
  type?: string;
  headers?: Record<string, string>;
  route?: string;
  csrfCookie?: boolean;
}

function request(path: string, options: Options = {}) {
  const url = new URL(path, ORIGIN);
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { host: url.host, ...(options.headers ?? {}) };
  if (method !== 'GET') headers['origin'] ??= ORIGIN;
  if (options.type) headers['content-type'] = options.type;
  return {
    request: new Request(url, { method, headers, body: options.body ?? null }),
    url,
    routePattern: options.route ?? staticRoute(url.pathname),
    locals: {} as Record<string, unknown>,
    cookies: {
      get: (name: string) =>
        name === CSRF_COOKIE_NAME && options.csrfCookie !== false ? { value: TOKEN } : undefined,
      set: () => undefined,
      delete: () => undefined,
    },
    redirect: (to: string, status = 302) =>
      new Response(null, { status, headers: { Location: to } }),
  };
}

const rendered = () => vi.fn(async () => new Response('page', { status: 200 }));

beforeEach(() => {
  state.auth = { ctx: null, revoke: false, pending: null };
});

describe('a session owing its second step', () => {
  beforeEach(() => {
    state.auth = { ctx: null, revoke: false, pending: PENDING };
  });

  it.each(['/admin', '/admin/leads', '/admin/users?tab=x'])(
    'is sent from %s to /admin/2fa, keeping where it was going',
    async (path) => {
      const next = rendered();
      const res = await middleware(request(path), next);
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe(`/admin/2fa?next=${encodeURIComponent(path)}`);
      expect(next).not.toHaveBeenCalled();
      expect(res.headers.get('cache-control')).toContain('no-store');
    },
  );

  it('gets 401 two-step-required from an admin API, never its data', async () => {
    const next = rendered();
    const res = await middleware(request('/api/admin/leads/query', { method: 'GET' }), next);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'two-step-required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('gets the same 401 for a write, its form never read for a token', async () => {
    const next = rendered();
    // A form post with a valid token: had the middleware gone on, it would have read the
    // body for the token and let it through.
    const res = await middleware(
      request('/admin/account', {
        method: 'POST',
        type: 'application/x-www-form-urlencoded',
        body: `${CSRF_FIELD_NAME}=${TOKEN}&intent=name&display_name=x`,
      }),
      next,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin/2fa?next=%2Fadmin%2Faccount');
    const api = await middleware(
      request('/api/admin/me', {
        method: 'PATCH',
        type: 'application/json',
        body: '{"display_name":"x"}',
        headers: { [CSRF_HEADER_NAME]: TOKEN },
      }),
      next,
    );
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ ok: false, error: 'two-step-required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('reaches /admin/2fa and sign-out', async () => {
    const page = rendered();
    expect((await middleware(request('/admin/2fa'), page)).status).toBe(200);
    expect(page).toHaveBeenCalledOnce();
    const logout = rendered();
    const res = await middleware(
      request('/api/admin/auth/logout', {
        method: 'POST',
        type: 'application/json',
        body: '{}',
        headers: { [CSRF_HEADER_NAME]: TOKEN },
      }),
      logout,
    );
    expect(res.status).toBe(200);
    expect(logout).toHaveBeenCalledOnce();
  });

  it('is not let through by a path that reads as /admin/2fa while it routes elsewhere', async () => {
    // `url.pathname` resolves `..\` (the URL setter), while the router matched the lead route
    // (see "What a request is" in src/middleware.ts): both must name the two-step page.
    const next = rendered();
    const api = await middleware(request('/admin/2fa', { route: '/api/admin/leads/[id]' }), next);
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ ok: false, error: 'two-step-required' });
    const page = await middleware(request('/admin/2fa', { route: '/admin/leads/[id]' }), next);
    expect(page.status).toBe(302);
    expect(next).not.toHaveBeenCalled();
  });

  it('a cross-site post to the two-step page is refused (403)', async () => {
    const next = rendered();
    const res = await middleware(
      request('/admin/2fa', {
        method: 'POST',
        type: 'application/x-www-form-urlencoded',
        body: `${CSRF_FIELD_NAME}=${TOKEN}&intent=verify&code=123456`,
        headers: { origin: 'https://evil.example' },
      }),
      next,
    );
    expect(res.status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('its form with a stale token goes back to the page (expired-form), never run', async () => {
    const next = rendered();
    const res = await middleware(
      request('/admin/2fa', {
        method: 'POST',
        type: 'application/x-www-form-urlencoded',
        body: `${CSRF_FIELD_NAME}=${'c'.repeat(64)}&intent=verify&code=123456&next=%2Fadmin%2Fleads`,
      }),
      next,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/2fa?next=%2Fadmin%2Fleads&error=expired-form');
    expect(next).not.toHaveBeenCalled();
  });

  it('its form with the right token reaches the page', async () => {
    const next = rendered();
    const res = await middleware(
      request('/admin/2fa', {
        method: 'POST',
        type: 'application/x-www-form-urlencoded',
        body: `${CSRF_FIELD_NAME}=${TOKEN}&intent=verify&code=123456`,
      }),
      next,
    );
    expect(res.status).toBe(200);
    expect(next).toHaveBeenCalledOnce();
  });

  it('keeps the sign-in screens open (signing in as someone else, a reset link)', async () => {
    const next = rendered();
    expect((await middleware(request('/admin/login'), next)).status).toBe(200);
    expect((await middleware(request('/admin/reset'), next)).status).toBe(200);
  });

  it('puts the pending step, never a context, on locals', async () => {
    const ctx = request('/admin/2fa');
    await middleware(ctx, rendered());
    expect(ctx.locals['session']).toBeNull();
    expect(ctx.locals['secondStep']).toEqual(PENDING);
  });
});

describe('everyone else on /admin/2fa', () => {
  it('a visitor with no session is sent to sign in', async () => {
    const next = rendered();
    const res = await middleware(request('/admin/2fa'), next);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin/login?next=%2Fadmin%2F2fa');
    expect(next).not.toHaveBeenCalled();
  });

  it('a full session reaches it (set up or manage 2FA) and keeps every other page', async () => {
    state.auth = { ctx: FULL, revoke: false, pending: null };
    for (const path of ['/admin/2fa', '/admin/leads', '/admin']) {
      const next = rendered();
      expect((await middleware(request(path), next)).status, path).toBe(200);
    }
  });
});
