import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import type { AuthContext } from '@/lib/auth/types';
import type { PendingSecondStep } from '@/lib/auth/twoStep';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/http/csrf';
import { PRE_AUTH_BODY_LIMIT, PRIVATE_FORM_BODY_LIMIT } from '@/lib/auth/bodyLimit';
import { TENANT, UUID } from './harness';

// Sign-in is the one admin API the endpoint matrix cannot drive: it is reached without a
// session and checks no capability (NOT_DRIVABLE in tests/authz/endpointCoverage.spec.ts).
// Its guards are driven here instead (CLAUDE.md §3: "Login lockout: 5 failures / 15 min →
// 423 for 15 min; generic copy (no enumeration)"):
//   - the middleware in front of it: a cross-site POST, or one without the double-submit
//     token, is refused before the handler; sign-in alone passes without a session, while
//     sign-out beside it answers 401 (its guard is the session, not a capability);
//   - the handler, with the real lockout module: a body that is neither JSON nor a form
//     post is a 400 before anything is looked up; every failed sign-in answers the same 401
//     body, the fifth failure answers 423, a locked address is refused before its password
//     is tried, and an unreachable lockout store fails closed;
//   - sign-in v2 (Admin v2 F7): the zero-JS form's post answers with a 303 (to `next`, or
//     back to the login page with one code for every failure, and never the address), the
//     `next` it carries is held to /admin, and "Keep me signed in" reaches the session
//     cookie's lifetime (src/lib/auth/session.ts, tested in tests/lib/session.spec.ts);
//   - the middleware lets the three sign-in screens and their three endpoints through
//     without a session, and nothing else.
// The counting itself is SQL (0009: login_is_locked, register_failed_login), stubbed below
// with the same contract; no pgTAP test covers that SQL yet.

const state = vi.hoisted(() => ({
  /** 0009's default p_threshold: this many failures inside the window lock the address. */
  threshold: 5,
  /** Failed attempts per address inside the window, as public.login_attempts counts them. */
  failures: new Map<string, number>(),
  /** Every lockout RPC called, in order. */
  rpcs: [] as string[],
  /** False when the lockout store cannot answer: every RPC errors. */
  storeUp: true,
  /** What resolveAuthContext finds for the session a sign-in creates. */
  auth: { ctx: null, revoke: false } as {
    ctx: AuthContext | null;
    revoke: boolean;
    pending?: PendingSecondStep | null;
  },
  clearSessionCookies: vi.fn(),
  /** The "Keep me signed in" choice each sign-in recorded, in order. */
  chooseSessionPersistence: vi.fn(),
  /** Each time a sign-in wrote that choice into the browser's marker cookie. */
  commitSessionPersistence: vi.fn(),
}));

// The lockout RPCs answer the way 0009's do: a failure is recorded first, then compared
// with the threshold; a success is recorded and does not lower the failure count.
vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    rpc: async (fn: string, args: { p_email: string }) => {
      state.rpcs.push(fn);
      if (!state.storeUp) return { data: null, error: { message: 'unreachable' } };
      const failed = state.failures.get(args.p_email) ?? 0;
      if (fn === 'login_is_locked') return { data: failed >= state.threshold, error: null };
      if (fn === 'register_failed_login') {
        state.failures.set(args.p_email, failed + 1);
        return { data: failed + 1 >= state.threshold, error: null };
      }
      return { data: null, error: null };
    },
  }),
}));
vi.mock('@/lib/auth/context', () => ({ resolveAuthContext: async () => state.auth }));
vi.mock('@/lib/auth/session', () => ({
  createSessionClient: () => ({}),
  clearSessionCookies: state.clearSessionCookies,
  chooseSessionPersistence: (_cookies: unknown, remember: boolean) =>
    state.chooseSessionPersistence(remember),
  commitSessionPersistence: () => state.commitSessionPersistence(),
  HOST_COOKIE_BASE: {},
}));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

const { onRequest } = await import('@/middleware');
const { POST } = (await import('@/pages/api/admin/auth/login')) as { POST: APIRoute };
const { LOCKOUT_DURATION_MINUTES, LOCKOUT_THRESHOLD } = await import('@/lib/auth/lockout');

type Handler = (context: unknown, next: () => Promise<Response>) => Promise<Response>;
const middleware = onRequest as unknown as Handler;

beforeEach(() => {
  state.failures.clear();
  state.rpcs.length = 0;
  state.storeUp = true;
  state.auth = { ctx: null, revoke: false };
  state.clearSessionCookies.mockClear();
  state.chooseSessionPersistence.mockReset();
  state.commitSessionPersistence.mockReset();
});

// ── The middleware ──────────────────────────────────────────────────────────────

const ORIGIN = 'https://admin.example.test';
const TOKEN = 'a'.repeat(64);

/**
 * The route Astro matches for the static pages and endpoints these tests reach: the path
 * without a trailing slash. The middleware reads it beside the path (`context.routePattern`).
 */
const staticRoute = (pathname: string): string =>
  pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname;

/** A POST to an admin API path with no session, carrying the double-submit cookie. */
function post(path: string, headers: Record<string, string>) {
  const url = new URL(path, ORIGIN);
  return {
    request: new Request(url, {
      method: 'POST',
      headers: { host: url.host, 'content-type': 'application/json', ...headers },
      body: '{}',
    }),
    url,
    routePattern: staticRoute(url.pathname),
    locals: {},
    cookies: {
      get: (name: string) => (name === CSRF_COOKIE_NAME ? { value: TOKEN } : undefined),
      set: () => undefined,
      delete: () => undefined,
    },
    redirect: (to: string, status = 302) =>
      new Response(null, { status, headers: { Location: to } }),
  };
}

const handler = () => vi.fn(async () => new Response('{"ok":true}', { status: 200 }));

describe('the middleware in front of sign-in and sign-out', () => {
  it('refuses a cross-site sign-in before the handler', async () => {
    const next = handler();
    const res = await middleware(
      post('/api/admin/auth/login', { origin: 'https://evil.example', [CSRF_HEADER_NAME]: TOKEN }),
      next,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'bad-origin' });
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses a sign-in without the double-submit token, or with another one', async () => {
    // No Origin at all is what a classic cross-site form POST can look like, so the token
    // is the guard that has to hold there.
    for (const headers of [
      {},
      { origin: ORIGIN },
      { origin: ORIGIN, [CSRF_HEADER_NAME]: 'b'.repeat(64) },
    ]) {
      const next = handler();
      const res = await middleware(post('/api/admin/auth/login', headers), next);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ ok: false, error: 'csrf' });
      expect(next).not.toHaveBeenCalled();
    }
  });

  it('lets a same-origin sign-in with the token reach the handler without a session', async () => {
    const next = handler();
    const res = await middleware(
      post('/api/admin/auth/login', { origin: ORIGIN, [CSRF_HEADER_NAME]: TOKEN }),
      next,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
  });

  it('answers a sign-out without a session with 401, before the handler', async () => {
    const next = handler();
    const res = await middleware(
      post('/api/admin/auth/logout', { origin: ORIGIN, [CSRF_HEADER_NAME]: TOKEN }),
      next,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'unauthenticated' });
    expect(next).not.toHaveBeenCalled();
  });

  it("takes a form post's token from its hidden field (the zero-JS sign-in screen)", async () => {
    const formPost = (field: string) => {
      const ctx = post('/api/admin/auth/login', { origin: ORIGIN });
      ctx.request = new Request(ctx.url, {
        method: 'POST',
        headers: {
          host: ctx.url.host,
          origin: ORIGIN,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ _csrf: field, email: 'a@b.test', password: 'x' }),
      });
      return ctx;
    };
    const good = handler();
    expect((await middleware(formPost(TOKEN), good)).status).toBe(200);
    expect(good).toHaveBeenCalledOnce();

    // A forged one never reaches the handler: the form goes back to its page (below).
    const forged = handler();
    const res = await middleware(formPost('b'.repeat(64)), forged);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/login?error=expired-form');
    expect(forged).not.toHaveBeenCalled();
  });
});

describe('a sign-in form post that fails the token check goes back to its page (F7 review)', () => {
  // The screens are zero-JS forms, so the browser shows whatever the refusal is. A JSON 403
  // was a dead end, met in ordinary use: __Host-csrf is a session cookie, so a sign-in tab a
  // browser restores after a restart carries a token that matches nothing.

  /** A urlencoded post with `fields`, the double-submit cookie set to TOKEN (or absent). */
  function formPost(
    path: string,
    fields: Record<string, string>,
    options: { cookie?: boolean; headers?: Record<string, string> } = {},
  ) {
    const ctx = post(path, {});
    ctx.request = new Request(ctx.url, {
      method: 'POST',
      headers: {
        host: ctx.url.host,
        origin: ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
        ...options.headers,
      },
      body: new URLSearchParams(fields),
    });
    if (options.cookie === false) ctx.cookies.get = () => undefined;
    return ctx;
  }

  const RESET_TOKEN = 'a1b2c3d4'.repeat(7);

  it.each([
    ['/api/admin/auth/login', '/admin/login?error=expired-form'],
    ['/api/admin/auth/forgot', '/admin/forgot?status=expired-form'],
    ['/api/admin/auth/reset', '/admin/reset?error=expired-form'],
    ['/api/admin/auth/invite', '/admin/invite?error=expired-form'],
  ])('%s: 303 to %s, never the handler, never cached', async (path, location) => {
    for (const [fields, cookie] of [
      [{ email: 'a@b.test' }, true], // no token in the form
      [{ _csrf: 'b'.repeat(64), email: 'a@b.test' }, true], // another token
      [{ _csrf: TOKEN, email: 'a@b.test' }, false], // the cookie is gone (browser restart)
    ] as const) {
      const next = handler();
      const res = await middleware(formPost(path, fields, { cookie }), next);
      expect(res.status, JSON.stringify(fields)).toBe(303);
      expect(res.headers.get('location')).toBe(location);
      expect(res.headers.get('cache-control')).toContain('no-store');
      expect(await res.text()).toBe('');
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("keeps what the page had: sign-in's `next` (held to /admin), the reset link (in its cookie)", async () => {
    const answer = (path: string, fields: Record<string, string>) =>
      middleware(formPost(path, fields), handler());
    const back = async (path: string, fields: Record<string, string>) =>
      (await answer(path, fields)).headers.get('location');

    expect(
      await back('/api/admin/auth/login', { next: '/admin/users?x=1', email: 'a@b.test' }),
    ).toBe(
      `/admin/login?${new URLSearchParams({ next: '/admin/users?x=1', error: 'expired-form' })}`,
    );
    expect(await back('/api/admin/auth/login', { next: 'https://evil.example/admin' })).toBe(
      '/admin/login?error=expired-form',
    );
    // The reset link's token goes back in the page's own cookie, never into the URL (request
    // URLs are logged: src/lib/auth/resetToken.ts).
    const reset = await answer('/api/admin/auth/reset', {
      token_hash: RESET_TOKEN,
      password: 'p',
      confirm: 'p',
    });
    expect(reset.headers.get('location')).toBe('/admin/reset?error=expired-form');
    expect(reset.headers.getSetCookie()).toEqual([
      `__Secure-braiin-reset=${RESET_TOKEN}; Max-Age=900; Path=/admin/reset; Secure; HttpOnly; SameSite=Strict`,
    ]);
    // A token of the wrong shape is not carried; nothing typed is, ever.
    const odd = await answer('/api/admin/auth/reset', { token_hash: '<x>', password: 'secret pw' });
    expect(odd.headers.get('location')).toBe('/admin/reset?error=expired-form');
    expect(odd.headers.getSetCookie()).toEqual([]);
    // The invite link likewise, in the invite page's own cookie (src/lib/auth/inviteToken.ts).
    const invite = await answer('/api/admin/auth/invite', {
      token_hash: RESET_TOKEN,
      password: 'p',
      confirm: 'p',
    });
    expect(invite.headers.get('location')).toBe('/admin/invite?error=expired-form');
    expect(invite.headers.getSetCookie()).toEqual([
      `__Secure-braiin-invite=${RESET_TOKEN}; Max-Age=900; Path=/admin/invite; Secure; HttpOnly; SameSite=Strict`,
    ]);
    const forgot = await back('/api/admin/auth/forgot', { email: 'staff@example.test' });
    expect(forgot).toBe('/admin/forgot?status=expired-form');
    expect(forgot).not.toContain('example.test');
  });

  it('keeps the JSON 403 for a script: a JSON body, or the token header', async () => {
    for (const path of [
      '/api/admin/auth/login',
      '/api/admin/auth/forgot',
      '/api/admin/auth/reset',
      '/api/admin/auth/invite',
    ]) {
      const json = handler();
      const res = await middleware(post(path, { origin: ORIGIN }), json);
      expect(res.status, path).toBe(403);
      expect(await res.json()).toEqual({ ok: false, error: 'csrf' });

      const header = handler();
      const viaHeader = await middleware(
        formPost(path, { email: 'a@b.test' }, { headers: { [CSRF_HEADER_NAME]: 'b'.repeat(64) } }),
        header,
      );
      expect(viaHeader.status, path).toBe(403);
      expect(json).not.toHaveBeenCalled();
      expect(header).not.toHaveBeenCalled();
    }
  });

  it('an empty token header is no token header: the form still goes back (F7 review)', async () => {
    // The same question as the middleware's (src/lib/http/csrf.ts `csrfHeaderToken`): an
    // empty header carries no token, so the post is a form's and is read like one.
    const next = handler();
    const res = await middleware(
      formPost(
        '/api/admin/auth/login',
        { _csrf: 'b'.repeat(64), email: 'a@b.test' },
        { headers: { [CSRF_HEADER_NAME]: '' } },
      ),
      next,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/login?error=expired-form');
    expect(next).not.toHaveBeenCalled();
    // And with the right token in its field, it is let through.
    const good = handler();
    await middleware(
      formPost(
        '/api/admin/auth/login',
        { _csrf: TOKEN, email: 'a@b.test' },
        { headers: { [CSRF_HEADER_NAME]: '' } },
      ),
      good,
    );
    expect(good).toHaveBeenCalledOnce();
  });

  it('and only the sign-in forms: any other admin form post keeps the JSON 403', async () => {
    // Signed in (signed out, another path is the session gate's: below).
    state.auth = { ctx: DEVELOPER, revoke: false };
    for (const path of ['/api/admin/auth/logout', '/api/admin/leads', '/admin/login']) {
      const next = handler();
      const res = await middleware(formPost(path, { email: 'a@b.test' }), next);
      expect(res.status, path).toBe(403);
      expect(await res.json()).toEqual({ ok: false, error: 'csrf' });
      expect(next).not.toHaveBeenCalled();
    }
    // Signed out, the sign-in page itself (a pre-auth path, but not a form endpoint).
    state.auth = { ctx: null, revoke: false };
    const next = handler();
    const res = await middleware(formPost('/admin/login', { email: 'a@b.test' }), next);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'csrf' });
  });

  it('a cross-site post is still the JSON 403 (the origin check comes first)', async () => {
    const next = handler();
    const res = await middleware(
      formPost(
        '/api/admin/auth/login',
        { email: 'a@b.test' },
        { headers: { origin: 'https://evil.example' } },
      ),
      next,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'bad-origin' });
    expect(next).not.toHaveBeenCalled();
  });
});

describe('the pre-auth body limit, before anything reads a body (F7 final review)', () => {
  /** A POST to `path` with `body`, its Content-Length declared (or not, for a stream). */
  function sized(
    path: string,
    body: BodyInit,
    headers: Record<string, string>,
    declare: number | null,
  ) {
    const ctx = post(path, {});
    ctx.request = new Request(ctx.url, {
      method: 'POST',
      headers: {
        host: ctx.url.host,
        origin: ORIGIN,
        ...(declare === null ? {} : { 'content-length': String(declare) }),
        ...headers,
      },
      body,
      duplex: 'half',
    } as RequestInit);
    return ctx;
  }
  const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
  const JSON_TYPE = { 'content-type': 'application/json' };
  const OVER = PRE_AUTH_BODY_LIMIT + 1;

  it.each([
    ['/api/admin/auth/login', '/admin/login?error=too-large'],
    ['/api/admin/auth/forgot', '/admin/forgot?status=too-large'],
    ['/api/admin/auth/reset', '/admin/reset?error=too-large'],
    ['/api/admin/auth/invite', '/admin/invite?error=too-large'],
  ])('a form over the limit to %s goes back to %s, unread', async (path, location) => {
    // The token is right: the size is refused first, so nothing of the body is read, not even
    // to find it (or `next`, or the reset link).
    const fields = new URLSearchParams({ _csrf: TOKEN, next: '/admin/users', pad: 'x' });
    const next = handler();
    const res = await middleware(sized(path, fields, FORM, OVER), next);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(location);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(next).not.toHaveBeenCalled();
  });

  it('a script gets a JSON 413, a page path too', async () => {
    for (const path of [
      '/api/admin/auth/login',
      '/api/admin/auth/forgot',
      '/api/admin/auth/reset',
      '/api/admin/auth/invite',
      '/admin/login',
      '/admin/invite',
    ]) {
      const next = handler();
      const res = await middleware(
        sized(path, '{}', { ...JSON_TYPE, [CSRF_HEADER_NAME]: TOKEN }, OVER),
        next,
      );
      expect(res.status, path).toBe(413);
      expect(await res.json()).toEqual({ ok: false, error: 'too-large' });
      expect(next).not.toHaveBeenCalled();
    }
  });

  it('a body with no Content-Length is measured, and refused past the limit', async () => {
    const stream = (bytes: number) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let sent = 0; sent < bytes; sent += 1024) {
            controller.enqueue(new Uint8Array(Math.min(1024, bytes - sent)).fill(0x61));
          }
          controller.close();
        },
      });
    const over = handler();
    const res = await middleware(
      sized(
        '/api/admin/auth/login',
        stream(OVER),
        { ...JSON_TYPE, [CSRF_HEADER_NAME]: TOKEN },
        null,
      ),
      over,
    );
    expect(res.status).toBe(413);
    expect(over).not.toHaveBeenCalled();

    const within = handler();
    const ok = await middleware(
      sized(
        '/api/admin/auth/login',
        stream(PRE_AUTH_BODY_LIMIT),
        { ...JSON_TYPE, [CSRF_HEADER_NAME]: TOKEN },
        null,
      ),
      within,
    );
    expect(within).toHaveBeenCalledOnce();
    expect(ok.status).toBe(200);
  });

  it('a body at the limit reaches the handler, with its token checked as before', async () => {
    const next = handler();
    const res = await middleware(
      sized(
        '/api/admin/auth/login',
        '{}',
        { ...JSON_TYPE, [CSRF_HEADER_NAME]: TOKEN },
        PRE_AUTH_BODY_LIMIT,
      ),
      next,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
  });

  it('applies to the pre-auth paths only: another admin path is not its business', async () => {
    const next = handler();
    const res = await middleware(
      sized('/api/admin/auth/logout', '{}', { ...JSON_TYPE, [CSRF_HEADER_NAME]: TOKEN }, OVER),
      next,
    );
    // No session: sign-out's own guard answers, not the size.
    expect(res.status).toBe(401);
  });

  it('a cross-site post is still the origin refusal, before the size', async () => {
    const next = handler();
    const res = await middleware(
      sized('/api/admin/auth/login', 'x', { ...FORM, origin: 'https://evil.example' }, OVER),
      next,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'bad-origin' });
  });
});

describe('a body is never read before the session gate has answered (F7 review)', () => {
  // Before: a signed-out POST to any admin path that needs a session had its urlencoded body
  // cloned by the CSRF check, with no bound, before the 401 (one copy for the clone, one
  // buffered behind it for the unread original), enough to take down the isolate.

  /** An endless body that counts each time anything asks it for bytes. None, unread. */
  function endless(pulls: { count: number }) {
    return new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls.count += 1;
          controller.enqueue(new Uint8Array(1024 * 1024).fill(0x61));
        },
      },
      new CountQueuingStrategy({ highWaterMark: 0 }),
    );
  }

  /** A same-origin POST to `path` with `body` and `headers`. */
  function postBody(path: string, body: BodyInit, headers: Record<string, string>) {
    const ctx = post(path, {});
    ctx.request = new Request(ctx.url, {
      method: 'POST',
      headers: { host: ctx.url.host, origin: ORIGIN, ...headers },
      body,
      duplex: 'half',
    } as RequestInit);
    return ctx;
  }
  const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

  it('signed out, an admin API answers 401 and reads nothing of the body', async () => {
    for (const declared of [{}, { 'content-length': String(100 * 1024 * 1024) }]) {
      const pulls = { count: 0 };
      const next = handler();
      const res = await middleware(
        postBody('/api/admin/leads', endless(pulls), { ...FORM, ...declared }),
        next,
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: 'unauthenticated' });
      expect(pulls.count, JSON.stringify(declared)).toBe(0);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it('signed out, an admin page sends the post to sign in, the body unread', async () => {
    const pulls = { count: 0 };
    const res = await middleware(postBody('/admin/users', endless(pulls), FORM), handler());
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      `/admin/login?next=${encodeURIComponent('/admin/users')}`,
    );
    expect(pulls.count).toBe(0);
  });

  it('signed out, a JSON post with a token header is the same 401', async () => {
    const res = await middleware(
      postBody('/api/admin/leads', '{}', {
        'content-type': 'application/json',
        [CSRF_HEADER_NAME]: TOKEN,
      }),
      handler(),
    );
    expect(res.status).toBe(401);
  });

  it('the sign-in paths with a trailing slash are sign-in paths: capped, and let through', async () => {
    // trailingSlash 'ignore': `/api/admin/auth/login/` IS the sign-in endpoint.
    const over = String(PRE_AUTH_BODY_LIMIT + 1);
    const form = await middleware(
      postBody('/api/admin/auth/login/', 'pad=x', { ...FORM, 'content-length': over }),
      handler(),
    );
    expect(form.status).toBe(303);
    expect(form.headers.get('location')).toBe('/admin/login?error=too-large');
    for (const path of ['/admin/login/', '/api/admin/auth/forgot/', '/api/admin/auth/reset//']) {
      const pulls = { count: 0 };
      const res = await middleware(
        postBody(path, endless(pulls), {
          'content-type': 'application/json',
          [CSRF_HEADER_NAME]: TOKEN,
        }),
        handler(),
      );
      expect(res.status, path).toBe(413);
      // An endless body is read up to the limit and no further.
      expect(pulls.count, path).toBeLessThanOrEqual(2);
    }
    const next = handler();
    const ok = await middleware(
      postBody('/api/admin/auth/login/', '{}', {
        'content-type': 'application/json',
        [CSRF_HEADER_NAME]: TOKEN,
      }),
      next,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(ok.status).toBe(200);
  });

  it('signed in, the form body the middleware reads for its token is bounded too', async () => {
    state.auth = { ctx: DEVELOPER, revoke: false };
    const pulls = { count: 0 };
    const big = await middleware(
      postBody('/admin/account', endless(pulls), {
        ...FORM,
        'content-length': String(PRIVATE_FORM_BODY_LIMIT + 1),
      }),
      handler(),
    );
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ ok: false, error: 'too-large' });
    expect(pulls.count).toBe(0);
    // A form of an honest size goes on to the token check, and with its token, through.
    const next = handler();
    const ok = await middleware(
      postBody('/admin/account', new URLSearchParams({ _csrf: TOKEN, intent: 'name' }), FORM),
      next,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(ok.status).toBe(200);
  });

  it('signed in, an empty token header is no token: the form is bounded all the same (F7 review)', async () => {
    // The bound asked whether the header was there; the reader, whether it held a token. So
    // an empty one skipped the 1 MB bound and the reader, finding nothing in it, read the
    // whole form for its field: eight megabytes here, a 403 after nine reads.
    state.auth = { ctx: DEVELOPER, revoke: false };
    /** `megabytes` of form body, then its end, counting each time anything reads it. */
    const finite = (megabytes: number, pulls: { count: number }) =>
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls.count += 1;
            if (pulls.count > megabytes) controller.close();
            else controller.enqueue(new Uint8Array(1024 * 1024).fill(0x61));
          },
        },
        new CountQueuingStrategy({ highWaterMark: 0 }),
      );
    const EMPTY = { [CSRF_HEADER_NAME]: '' };
    const pulls = { count: 0 };
    const big = await middleware(
      postBody('/admin/account', finite(8, pulls), { ...FORM, ...EMPTY }),
      handler(),
    );
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ ok: false, error: 'too-large' });
    // Read up to the limit and no further.
    expect(pulls.count).toBeLessThanOrEqual(3);
    // Declared, it is refused unread.
    const declared = { count: 0 };
    const sized = await middleware(
      postBody('/admin/account', finite(8, declared), {
        ...FORM,
        ...EMPTY,
        'content-length': String(8 * 1024 * 1024),
      }),
      handler(),
    );
    expect(sized.status).toBe(413);
    expect(declared.count).toBe(0);
    // An honest form with an empty header is read for its field, as with none.
    const next = handler();
    const ok = await middleware(
      postBody('/admin/account', new URLSearchParams({ _csrf: TOKEN, intent: 'name' }), {
        ...FORM,
        ...EMPTY,
      }),
      next,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(ok.status).toBe(200);
  });

  it("signed in, a JSON save is not the middleware's to bound: it never reads it", async () => {
    state.auth = { ctx: DEVELOPER, revoke: false };
    const pulls = { count: 0 };
    const next = handler();
    await middleware(
      postBody('/api/admin/leads', endless(pulls), {
        'content-type': 'application/json',
        [CSRF_HEADER_NAME]: TOKEN,
      }),
      next,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(pulls.count).toBe(0);
  });
});

describe('a path that reads public but routes private is private (F7 final review)', () => {
  // Astro's router matches the decoded path as it is, while `url.pathname` has been through
  // the URL setter, which resolves dot segments and reads `\` as `/`. So
  // `/api/admin/leads/..%5Cauth%5Clogin` runs the lead endpoint while its pathname reads as
  // the sign-in endpoint, and `/api/admin/leads/..%5C..%5C..` reads as `/`. Modelled here
  // by the two values the middleware sees: the pathname and the route Astro matched.
  const routed = <T extends { routePattern: string }>(ctx: T, routePattern: string): T => ({
    ...ctx,
    routePattern,
  });

  it('a post that reads as the sign-in endpoint but routes to a lead is not pre-auth', async () => {
    const next = handler();
    const res = await middleware(
      routed(
        post('/api/admin/auth/login', { origin: ORIGIN, [CSRF_HEADER_NAME]: TOKEN }),
        '/api/admin/leads/[id]',
      ),
      next,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'unauthenticated' });
    expect(next).not.toHaveBeenCalled();
  });

  it('the invite paths (U12b) are pre-auth only when the route is the invite page or endpoint', async () => {
    // Reads as the invite endpoint, routes to a colleague's invite (cancel): needs a session.
    const next = handler();
    const res = await middleware(
      routed(
        post('/api/admin/auth/invite', { origin: ORIGIN, [CSRF_HEADER_NAME]: TOKEN }),
        '/api/admin/users/[id]/invite',
      ),
      next,
    );
    expect(res.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
    // Reads as a lead, routes to the invite endpoint: not pre-auth either.
    const other = handler();
    const viaLead = await middleware(
      routed(
        post('/api/admin/leads/x', { origin: ORIGIN, [CSRF_HEADER_NAME]: TOKEN }),
        '/api/admin/auth/invite',
      ),
      other,
    );
    expect(viaLead.status).toBe(401);
    expect(other).not.toHaveBeenCalled();
  });

  it('a request that reads as / but routes to an admin API is private: 401, never cached', async () => {
    const next = handler();
    const ctx = post('/', { origin: ORIGIN, [CSRF_HEADER_NAME]: TOKEN });
    const res = await middleware(routed(ctx, '/api/admin/leads/[id]'), next);
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control') ?? '').toMatch(/no-store/);
    expect(next).not.toHaveBeenCalled();
  });

  it('a page that reads as /x but routes to an admin editor sends the visitor to sign in', async () => {
    const next = handler();
    const ctx = post('/x', {});
    const res = await middleware(
      routed(
        { ...ctx, request: new Request(ctx.url, { headers: { host: ctx.url.host } }) },
        '/admin/blog/[id]',
      ),
      next,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location') ?? '').toMatch(/^\/admin\/login\?next=/);
    expect(next).not.toHaveBeenCalled();
  });

  it('the real sign-in endpoint, by path and by route, still reaches its handler', async () => {
    const next = handler();
    const res = await middleware(
      post('/api/admin/auth/login', { origin: ORIGIN, [CSRF_HEADER_NAME]: TOKEN }),
      next,
    );
    expect(res.status).toBe(200);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('what the middleware lets through without a session (Admin v2 F7)', () => {
  /** A GET with no session and no cookie at all. */
  function get(path: string) {
    const url = new URL(path, ORIGIN);
    return {
      request: new Request(url, { headers: { host: url.host } }),
      url,
      routePattern: staticRoute(url.pathname),
      locals: {},
      cookies: { get: () => undefined, set: () => undefined, delete: () => undefined },
      redirect: (to: string, status = 302) =>
        new Response(null, { status, headers: { Location: to } }),
    };
  }
  const page = () => vi.fn(async () => new Response('<html></html>', { status: 200 }));

  it.each(['/admin/login', '/admin/forgot', '/admin/reset', '/admin/invite'])(
    'renders %s',
    async (path) => {
      const next = page();
      const res = await middleware(get(`${path}?x=1`), next);
      expect(next).toHaveBeenCalledOnce();
      expect(res.status).toBe(200);
      // Still Tier C: never cached.
      expect(res.headers.get('cache-control')).toContain('no-store');
    },
  );

  it.each([
    '/api/admin/auth/login',
    '/api/admin/auth/forgot',
    '/api/admin/auth/reset',
    '/api/admin/auth/invite',
  ])('lets a same-origin POST to %s with the token reach its handler', async (path) => {
    const next = handler();
    const res = await middleware(post(path, { origin: ORIGIN, [CSRF_HEADER_NAME]: TOKEN }), next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
  });

  it.each(['/api/admin/auth/forgot', '/api/admin/auth/reset', '/api/admin/auth/invite'])(
    'still refuses a cross-site or tokenless POST to %s',
    async (path) => {
      for (const headers of [
        { origin: 'https://evil.example', [CSRF_HEADER_NAME]: TOKEN },
        { origin: ORIGIN },
      ]) {
        const next = handler();
        const res = await middleware(post(path, headers), next);
        expect(res.status).toBe(403);
        expect(next).not.toHaveBeenCalled();
      }
    },
  );

  it('and nothing else: another screen goes to sign in, another API answers 401', async () => {
    for (const path of [
      '/admin',
      '/admin/users',
      '/admin/forgot-me',
      '/admin/reset/x',
      '/admin/invite/x',
      '/admin/invites',
    ]) {
      const next = page();
      const res = await middleware(get(path), next);
      expect(res.status, path).toBe(302);
      expect(res.headers.get('location'), path).toBe(
        `/admin/login?next=${encodeURIComponent(path)}`,
      );
      expect(next).not.toHaveBeenCalled();
    }
    const next = handler();
    const res = await middleware(
      post('/api/admin/auth/other', { origin: ORIGIN, [CSRF_HEADER_NAME]: TOKEN }),
      next,
    );
    expect(res.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});

// ── The handler ─────────────────────────────────────────────────────────────────

const EMAIL = 'staff@example.test';
const PASSWORD = 'correct horse battery';
/** The one body every failed sign-in answers, byte for byte. */
const GENERIC = JSON.stringify({ ok: false, error: 'invalid-credentials' });
const LOCKED = { ok: false, error: 'locked', retryAfterMinutes: LOCKOUT_DURATION_MINUTES };

/** The session client a sign-in runs on: GoTrue accepts PASSWORD only. */
function sessionClient() {
  const audit: { table: string; row: Record<string, unknown> }[] = [];
  const client = {
    auth: {
      signInWithPassword: vi.fn(async ({ password }: { email: string; password: string }) =>
        password === PASSWORD
          ? { data: {}, error: null }
          : { data: {}, error: { message: 'Invalid login credentials' } },
      ),
      signOut: vi.fn(async () => ({ error: null })),
    },
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        audit.push({ table, row });
        return { error: null };
      },
    }),
  };
  return { client, audit };
}

async function signIn(client: unknown, body: unknown): Promise<Response> {
  return signInRaw(client, JSON.stringify(body));
}

/** A sign-in whose body is `text`, as it is, sent as `type`. */
async function signInRaw(
  client: unknown,
  text: string | FormData,
  type: string | null = 'application/json',
): Promise<Response> {
  const headers: Record<string, string> = { 'cf-connecting-ip': '203.0.113.7' };
  if (type) headers['content-type'] = type;
  const request = new Request(`${ORIGIN}/api/admin/auth/login`, {
    method: 'POST',
    headers,
    body: text,
  });
  const ctx = { request, locals: { supabase: client }, cookies: {} };
  return (await POST(ctx as unknown as Parameters<APIRoute>[0])) as Response;
}

/** The sign-in screen's own post: a urlencoded form, as a browser without JS sends it. */
async function signInForm(client: unknown, fields: Record<string, string>): Promise<Response> {
  return signInRaw(
    client,
    new URLSearchParams(fields).toString(),
    'application/x-www-form-urlencoded',
  );
}

describe('POST /api/admin/auth/login', () => {
  it('answers a body that is neither JSON nor a form post with 400, before any lookup', async () => {
    // Not the generic 401: no address was read, so the answer cannot say anything about one.
    const { client } = sessionClient();
    const multipart = new FormData();
    multipart.set('email', EMAIL);
    for (const res of [
      await signInRaw(client, `email=${EMAIL}&password=${PASSWORD}`),
      await signInRaw(client, '[1,2]'),
      await signInRaw(client, multipart, null),
    ]) {
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'bad-request' });
    }
    expect(state.rpcs).toEqual([]);
    expect(client.auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it('answers a wrong password with the generic 401, and counts the failure', async () => {
    const { client } = sessionClient();
    const res = await signIn(client, { email: EMAIL, password: 'wrong password' });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe(GENERIC);
    expect(state.failures.get(EMAIL)).toBe(1);
  });

  it('answers a body the schema refuses with the same 401, naming no field', async () => {
    const { client } = sessionClient();
    for (const body of [
      { email: 'not an address', password: PASSWORD },
      { email: EMAIL },
      { email: EMAIL, password: 'short' },
      { email: EMAIL, password: 'x'.repeat(257) },
      { email: EMAIL, password: PASSWORD, remember: 'yes' },
    ]) {
      const res = await signIn(client, body);
      expect(res.status, JSON.stringify(body)).toBe(401);
      expect(await res.text()).toBe(GENERIC);
    }
    expect(client.auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it('answers valid credentials on an account that cannot hold a session with the same 401', async () => {
    // A deactivated profile, or no role claim: resolveAuthContext finds no staff context.
    const { client } = sessionClient();
    const res = await signIn(client, { email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe(GENERIC);
    // The session the sign-in created is torn down, and the attempt counts as a failure.
    expect(client.auth.signOut).toHaveBeenCalledOnce();
    expect(state.clearSessionCookies).toHaveBeenCalledOnce();
    expect(state.failures.get(EMAIL)).toBe(1);
  });

  it('answers the fifth failure with 423, and refuses a locked address before trying it', async () => {
    const { client } = sessionClient();
    for (let attempt = 1; attempt < LOCKOUT_THRESHOLD; attempt++) {
      const res = await signIn(client, { email: EMAIL, password: 'wrong password' });
      expect(res.status, `attempt ${attempt}`).toBe(401);
    }
    const fifth = await signIn(client, { email: EMAIL, password: 'wrong password' });
    expect(fifth.status).toBe(423);
    expect(await fifth.json()).toEqual(LOCKED);

    // Locked now: not even the right password is tried.
    const tried = client.auth.signInWithPassword.mock.calls.length;
    const locked = await signIn(client, { email: EMAIL, password: PASSWORD });
    expect(locked.status).toBe(423);
    expect(await locked.json()).toEqual(LOCKED);
    expect(client.auth.signInWithPassword).toHaveBeenCalledTimes(tried);

    // The lock is the address's, not everyone's.
    const other = await signIn(client, { email: 'other@example.test', password: 'wrong password' });
    expect(other.status).toBe(401);
  });

  it('fails closed: with the lockout store unreachable it answers 423 and tries nothing', async () => {
    state.storeUp = false;
    const { client } = sessionClient();
    const res = await signIn(client, { email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(423);
    expect(await res.json()).toEqual(LOCKED);
    expect(client.auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it('records and audits a good sign-in, and answers the role the server resolved', async () => {
    state.auth = {
      ctx: { userId: UUID, tenantId: TENANT, role: 'developer', isActive: true, email: EMAIL },
      revoke: false,
    };
    const { client, audit } = sessionClient();
    const res = await signIn(client, { email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { role: 'developer', email: EMAIL } });
    expect(state.rpcs).toEqual(['login_is_locked', 'register_successful_login']);
    expect(audit).toEqual([
      {
        table: 'audit_log',
        row: expect.objectContaining({
          action: 'auth.login',
          actor_id: UUID,
          entity_id: UUID,
          detail: { ip: '203.0.113.7', remember: true },
        }),
      },
    ]);
  });
});

const DEVELOPER: AuthContext = {
  userId: UUID,
  tenantId: TENANT,
  role: 'developer',
  isActive: true,
  email: EMAIL,
};

describe('"Keep me signed in" (Admin v2 F7)', () => {
  it('is on unless a JSON caller says otherwise (owner item O-14)', async () => {
    state.auth = { ctx: DEVELOPER, revoke: false };
    const { client } = sessionClient();
    await signIn(client, { email: EMAIL, password: PASSWORD });
    await signIn(client, { email: EMAIL, password: PASSWORD, remember: true });
    await signIn(client, { email: EMAIL, password: PASSWORD, remember: false });
    expect(state.chooseSessionPersistence.mock.calls).toEqual([[true], [true], [false]]);
  });

  it('follows the form box: ticked keeps the session, unticked (absent) does not', async () => {
    state.auth = { ctx: DEVELOPER, revoke: false };
    const { client } = sessionClient();
    await signInForm(client, { email: EMAIL, password: PASSWORD, remember: '1' });
    await signInForm(client, { email: EMAIL, password: PASSWORD });
    expect(state.chooseSessionPersistence.mock.calls).toEqual([[true], [false]]);
  });

  it('is chosen before the sign-in writes the session cookie, and kept only after it succeeds', async () => {
    state.auth = { ctx: DEVELOPER, revoke: false };
    const { client } = sessionClient();
    const order: string[] = [];
    state.chooseSessionPersistence.mockImplementationOnce(() => order.push('choose'));
    state.commitSessionPersistence.mockImplementationOnce(() => order.push('commit'));
    client.auth.signInWithPassword.mockImplementationOnce(async () => {
      order.push('sign-in');
      return { data: {}, error: null };
    });
    await signIn(client, { email: EMAIL, password: PASSWORD, remember: false });
    expect(order).toEqual(['choose', 'sign-in', 'commit']);
  });

  it('a failed sign-in never writes the choice into the browser (F7 review)', async () => {
    // A wrong password, from a login page left open in another tab with the box at its
    // default, must not change the lifetime of the session this browser already holds.
    const { client } = sessionClient();
    const wrong = await signInForm(client, { email: EMAIL, password: 'wrong password' });
    expect(wrong.headers.get('location')).toBe('/admin/login?error=invalid');
    // Valid credentials on an account that cannot hold a session: torn down, not kept.
    await signIn(client, { email: EMAIL, password: PASSWORD, remember: false });
    expect(state.chooseSessionPersistence).toHaveBeenCalledTimes(2);
    expect(state.commitSessionPersistence).not.toHaveBeenCalled();
  });

  it('is never chosen for a locked address or a body the schema refuses', async () => {
    const { client } = sessionClient();
    await signIn(client, { email: 'not an address', password: PASSWORD });
    state.storeUp = false;
    await signIn(client, { email: EMAIL, password: PASSWORD });
    expect(state.chooseSessionPersistence).not.toHaveBeenCalled();
    expect(state.commitSessionPersistence).not.toHaveBeenCalled();
  });
});

describe('the zero-JS sign-in form (Admin v2 F7)', () => {
  it('a good sign-in goes on to `next` with a 303', async () => {
    state.auth = { ctx: DEVELOPER, revoke: false };
    const { client, audit } = sessionClient();
    const res = await signInForm(client, {
      email: EMAIL,
      password: PASSWORD,
      remember: '1',
      next: '/admin/leads?stage=new',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/leads?stage=new');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(audit).toHaveLength(1);
  });

  it('holds `next` to /admin: an absolute, protocol-relative or other path goes to /admin', async () => {
    state.auth = { ctx: DEVELOPER, revoke: false };
    const { client } = sessionClient();
    for (const next of [
      'https://evil.example/admin',
      '//evil.example/admin',
      '/\\evil.example/admin',
      '/administrator',
      '/services',
      '',
    ]) {
      const res = await signInForm(client, { email: EMAIL, password: PASSWORD, next });
      expect(res.headers.get('location'), next).toBe('/admin');
    }
  });

  it('holds the path the browser resolves, and never 500s on a non-ASCII `next` (F7 review)', async () => {
    state.auth = { ctx: DEVELOPER, revoke: false };
    const { client } = sessionClient();
    for (const [next, location] of [
      ['/admin/../services', '/admin'],
      ['/admin/%2e%2e/x', '/admin'],
      ['/admin/..//evil.example', '/admin'],
      // Raw, this threw "Cannot convert argument to a ByteString" after a good sign-in.
      ['/admin/日', '/admin/%E6%97%A5'],
      ['/admin/leads?q=ü', '/admin/leads?q=%C3%BC'],
    ] as const) {
      const res = await signInForm(client, { email: EMAIL, password: PASSWORD, next });
      expect(res.status, next).toBe(303);
      expect(res.headers.get('location'), next).toBe(location);
    }
  });

  it('every failure comes back to the same page, with one code and never the address', async () => {
    const { client } = sessionClient();
    const locations: (string | null)[] = [];
    for (const fields of [
      { email: EMAIL, password: 'wrong password' },
      { email: 'nobody@example.test', password: 'wrong password' },
      { email: 'not an address', password: PASSWORD },
      { email: EMAIL },
    ]) {
      const res = await signInForm(client, { ...fields, next: '/admin/users' });
      expect(res.status).toBe(303);
      locations.push(res.headers.get('location'));
    }
    // A valid account whose profile cannot hold a session: the same answer again.
    const res = await signInForm(client, {
      email: EMAIL,
      password: PASSWORD,
      next: '/admin/users',
    });
    locations.push(res.headers.get('location'));

    expect(new Set(locations)).toEqual(
      new Set(['/admin/login?error=invalid&next=%2Fadmin%2Fusers']),
    );
    for (const location of locations) expect(location).not.toContain('example');
  });

  it('a locked address comes back with the lockout code, before its password is tried', async () => {
    state.failures.set(EMAIL, LOCKOUT_THRESHOLD);
    const { client } = sessionClient();
    const res = await signInForm(client, { email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/login?error=locked');
    expect(client.auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it('a request with no session client comes back as unavailable (the JSON caller: 500)', async () => {
    const res = await signInForm(null, { email: EMAIL, password: PASSWORD });
    expect(res.headers.get('location')).toBe('/admin/login?error=unavailable');
    const json = await signIn(null, { email: EMAIL, password: PASSWORD });
    expect(json.status).toBe(500);
  });
});

// ── Two-step sign-in (Admin v2 U17) ─────────────────────────────────────────────
// A right password on an account that owes its second step: the session stays (held at
// /admin/2fa by the middleware), and the sign-in is NOT finished: the failure count is not
// cleared (else whoever holds the password could try codes for ever) and nothing is audited
// until the code (src/lib/auth/twoStepFlow.ts writes `auth.login` then).
describe('a password that leaves the second step owed (U17)', () => {
  const PENDING = {
    userId: UUID,
    tenantId: TENANT,
    email: EMAIL,
    role: 'developer' as const,
    mode: 'challenge' as const,
    factorId: null,
  };

  it('keeps the session and the persistence choice; clears no failure, audits nothing', async () => {
    state.failures.set(EMAIL, 3);
    state.auth = { ctx: null, revoke: false, pending: PENDING };
    const { client, audit } = sessionClient();
    const res = await signIn(client, { email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { secondStep: 'challenge' } });
    expect(state.rpcs).toEqual(['login_is_locked']);
    expect(state.failures.get(EMAIL)).toBe(3);
    expect(audit).toEqual([]);
    expect(state.commitSessionPersistence).toHaveBeenCalledOnce();
    expect(client.auth.signOut).not.toHaveBeenCalled();
    expect(state.clearSessionCookies).not.toHaveBeenCalled();
  });

  it('the form post goes on to the two-step page, keeping where the person was going', async () => {
    state.auth = { ctx: null, revoke: false, pending: { ...PENDING, mode: 'enrol' } };
    const { client } = sessionClient();
    const res = await signInForm(client, {
      email: EMAIL,
      password: PASSWORD,
      next: '/admin/leads?view=board',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/2fa?next=%2Fadmin%2Fleads%3Fview%3Dboard');
    expect(res.headers.get('location')).not.toContain(EMAIL);
  });

  it('a wrong password is still a wrong password, whatever the account owes', async () => {
    state.auth = { ctx: null, revoke: false, pending: PENDING };
    const { client } = sessionClient();
    const res = await signIn(client, { email: EMAIL, password: 'wrong password' });
    expect(res.status).toBe(401);
    expect(state.failures.get(EMAIL)).toBe(1);
  });
});
