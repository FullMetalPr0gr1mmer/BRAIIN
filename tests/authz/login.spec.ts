import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import type { AuthContext } from '@/lib/auth/types';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/http/csrf';
import { TENANT, UUID } from './harness';

// Sign-in is the one admin API the endpoint matrix cannot drive: it is reached without a
// session and checks no capability (NOT_DRIVABLE in tests/authz/endpointCoverage.spec.ts).
// Its guards are driven here instead (CLAUDE.md §3: "Login lockout: 5 failures / 15 min →
// 423 for 15 min; generic copy (no enumeration)"):
//   - the middleware in front of it: a cross-site POST, or one without the double-submit
//     token, is refused before the handler; sign-in alone passes without a session, while
//     sign-out beside it answers 401 (its guard is the session, not a capability);
//   - the handler, with the real lockout module: every failure answers the same 401 body,
//     the fifth failure answers 423, a locked address is refused before its password is
//     tried, and an unreachable lockout store fails closed.
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
  auth: { ctx: null, revoke: false } as { ctx: AuthContext | null; revoke: boolean },
  clearSessionCookies: vi.fn(),
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
});

// ── The middleware ──────────────────────────────────────────────────────────────

const ORIGIN = 'https://admin.example.test';
const TOKEN = 'a'.repeat(64);

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
  const request = new Request(`${ORIGIN}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' },
    body: JSON.stringify(body),
  });
  const ctx = { request, locals: { supabase: client }, cookies: {} };
  return (await POST(ctx as unknown as Parameters<APIRoute>[0])) as Response;
}

describe('POST /api/admin/auth/login', () => {
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
          detail: { ip: '203.0.113.7' },
        }),
      },
    ]);
  });
});
