import { describe, it, expect, beforeEach, vi } from 'vitest';

// The middleware's half of a revoked session (Admin v2 U12a): when resolveAuthContext says a
// session must be torn down (a stale role or tenant, a switched-off or locked account, a
// sign-in older than the tenant's session length), the session is signed out at the auth
// server (this session only: `scope: 'local'`) BEFORE its cookies are cleared, so the refresh
// token in a copied cookie stops working too. Best effort: a sign-out that fails still clears
// the cookies and answers as usual. A session that is merely absent is signed out of nothing.

const { state } = vi.hoisted(() => ({
  state: {
    revoke: false,
    signOutFails: false,
    order: [] as string[],
    signOutArgs: [] as unknown[],
  },
}));

vi.mock('@/lib/auth/session', () => ({
  createSessionClient: () => ({
    auth: {
      signOut: async (args: unknown) => {
        state.order.push('signOut');
        state.signOutArgs.push(args);
        if (state.signOutFails) throw new Error('auth server down');
        return { error: null };
      },
    },
  }),
  clearSessionCookies: () => {
    state.order.push('clear');
  },
  HOST_COOKIE_BASE: {},
}));
vi.mock('@/lib/auth/context', () => ({
  resolveAuthContext: async () => ({ ctx: null, revoke: state.revoke }),
}));

const { onRequest } = await import('@/middleware');

type Handler = (context: unknown, next: () => Promise<Response>) => Promise<Response>;
const run = onRequest as unknown as Handler;

function context(path: string) {
  const url = new URL(`https://www.example.test${path}`);
  return {
    request: new Request(url),
    url,
    routePattern: path,
    locals: {},
    cookies: { get: () => undefined, set: () => undefined, delete: () => undefined },
    redirect: (to: string, status = 302) =>
      new Response(null, { status, headers: { Location: to } }),
  };
}

const next = async () => new Response('page', { status: 200 });

beforeEach(() => {
  state.revoke = false;
  state.signOutFails = false;
  state.order = [];
  state.signOutArgs = [];
});

describe('a revoked session is signed out, then its cookies cleared', () => {
  it('signs the session out locally before clearing the cookies', async () => {
    state.revoke = true;
    const res = await run(context('/admin/users'), next);
    expect(state.order).toEqual(['signOut', 'clear']);
    expect(state.signOutArgs).toEqual([{ scope: 'local' }]);
    // And the request goes to the sign-in page, as any signed-out one does.
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin/login?next=%2Fadmin%2Fusers');
  });

  it('still clears the cookies when the sign-out fails', async () => {
    state.revoke = true;
    state.signOutFails = true;
    const res = await run(context('/admin/users'), next);
    expect(state.order).toEqual(['signOut', 'clear']);
    expect(res.status).toBe(302);
  });

  it('signs nothing out when there was no session to revoke', async () => {
    const res = await run(context('/admin/login'), next);
    expect(state.order).toEqual([]);
    expect(res.status).toBe(200);
  });
});
