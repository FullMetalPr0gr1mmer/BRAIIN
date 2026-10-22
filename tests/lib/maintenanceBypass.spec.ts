import { describe, expect, it, vi } from 'vitest';
import type { AstroCookies } from 'astro';
import {
  BYPASS_TIMEOUT_MS,
  staffMayBypass,
  storedAccessToken,
  worthChecking,
} from '@/lib/http/maintenanceBypass';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { ROLES } from '@/lib/auth/types';

// The staff bypass of maintenance (Admin v2 U9b, decision D15) FAILS CLOSED: only a context the
// admin's own session check returns whole lets a request past the 503. No cookie, garbage, an
// expired token, a token with no member role, a check that throws, takes too long, revokes the
// session or holds it at its second step: each is no. And it has no side effects: it never
// signs anyone out (the admin does that on its own next request).

const NOW = Date.parse('2026-10-20T09:00:00Z');

const b64url = (value: string) =>
  Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

function jwt(payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'HS256' }))}.${b64url(JSON.stringify(payload))}.sig`;
}

const TOKEN = jwt({
  sub: '11111111-1111-4111-8111-111111111111',
  exp: NOW / 1000 + 3600,
  app_metadata: { role: 'admin', tenant_id: '22222222-2222-4222-8222-222222222222' },
});

/** The cookie as @supabase/ssr writes it (base64url of the session JSON). */
const sessionCookie = (token: string) =>
  `base64-${b64url(JSON.stringify({ access_token: token, refresh_token: 'r' }))}`;

function jar(cookies: Record<string, string>) {
  const signOut = vi.fn();
  const set = vi.fn();
  const del = vi.fn();
  return {
    jar: {
      get: (name: string) => (name in cookies ? { value: cookies[name] } : undefined),
      set,
      delete: del,
    } as unknown as AstroCookies,
    signOut,
    set,
    del,
  };
}

const live = {
  ctx: { userId: 'u', tenantId: 't', role: 'admin', isActive: true, email: '' },
  revoke: false,
};

describe('the local pre-filter never grants, and keeps garbage away from the auth server', () => {
  it('reads the access token from the cookie as @supabase/ssr writes it, whole or chunked', () => {
    expect(storedAccessToken(sessionCookie(TOKEN))).toBe(TOKEN);
    expect(storedAccessToken(JSON.stringify({ access_token: TOKEN }))).toBe(TOKEN);
    expect(storedAccessToken('base64-!!!')).toBeNull();
    expect(storedAccessToken('{}')).toBeNull();
    const value = sessionCookie(TOKEN);
    const chunked = jar({
      [`${SESSION_COOKIE_NAME}.0`]: value.slice(0, 40),
      [`${SESSION_COOKIE_NAME}.1`]: value.slice(40),
    });
    expect(worthChecking(chunked.jar, NOW)).toBe(true);
  });

  it.each([
    ['no cookie', {}],
    ['garbage', { [SESSION_COOKIE_NAME]: 'garbage' }],
    ['a token that is not a JWT', { [SESSION_COOKIE_NAME]: sessionCookie('abc') }],
    [
      'an expired token',
      {
        [SESSION_COOKIE_NAME]: sessionCookie(
          jwt({ sub: 'u', exp: NOW / 1000 - 1, app_metadata: { role: 'admin' } }),
        ),
      },
    ],
    [
      'a token with no member role',
      {
        [SESSION_COOKIE_NAME]: sessionCookie(
          jwt({ sub: 'u', exp: NOW / 1000 + 60, app_metadata: {} }),
        ),
      },
    ],
    [
      'a role that is not ours',
      {
        [SESSION_COOKIE_NAME]: sessionCookie(
          jwt({ sub: 'u', exp: NOW / 1000 + 60, app_metadata: { role: 'owner' } }),
        ),
      },
    ],
  ])('%s: no bypass, and the auth server is never asked', async (_, cookies) => {
    const resolve = vi.fn();
    const { jar: j } = jar(cookies as Record<string, string>);
    expect(await staffMayBypass(j, { now: NOW, resolve, sessionClient: () => ({}) as never })).toBe(
      false,
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  // The signed-in team (D14) is every member role, Sales included: a bypassed request renders
  // the anonymous public page (the middleware never sets a session for it), so a member sees
  // nothing a visitor would not once maintenance ends.
  it.each(ROLES)('%s is a member role: worth asking the session check', (role) => {
    const { jar: j } = jar({
      [SESSION_COOKIE_NAME]: sessionCookie(
        jwt({ sub: 'u', exp: NOW / 1000 + 60, app_metadata: { role } }),
      ),
    });
    expect(worthChecking(j, NOW)).toBe(true);
  });
});

describe('the admin’s session check decides, and fails closed', () => {
  const ask = (result: unknown, timeoutMs = BYPASS_TIMEOUT_MS) => {
    const { jar: j, signOut } = jar({ [SESSION_COOKIE_NAME]: sessionCookie(TOKEN) });
    const resolve = vi.fn(async () => {
      if (result instanceof Error) throw result;
      if (result === 'hang') return new Promise(() => undefined);
      return result;
    });
    const client = { auth: { signOut } };
    return {
      result: staffMayBypass(j, {
        now: NOW,
        resolve: resolve as never,
        sessionClient: () => client as never,
        timeoutMs,
      }),
      signOut,
      resolve,
    };
  };

  it('a whole context: through', async () => {
    const { result, signOut } = ask(live);
    expect(await result).toBe(true);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('no context (stale, deactivated, locked, moved), or a session to tear down: no', async () => {
    expect(await ask({ ctx: null, revoke: true }).result).toBe(false);
    expect(await ask({ ctx: null, revoke: false }).result).toBe(false);
    // A context with revoke set never counts either.
    expect(await ask({ ...live, revoke: true }).result).toBe(false);
  });

  it('held at its second step (Admin v2 U17): no', async () => {
    expect(await ask({ ctx: null, revoke: false, pending: { mode: 'challenge' } }).result).toBe(
      false,
    );
  });

  it('the auth server throws: no, and nobody is signed out', async () => {
    const { result, signOut } = ask(new Error('GoTrue 500'));
    expect(await result).toBe(false);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('the check takes longer than the limit: no', async () => {
    const { result } = ask('hang', 20);
    expect(await result).toBe(false);
    expect(BYPASS_TIMEOUT_MS).toBe(1_500);
  });

  it('a session client that cannot be made: no', async () => {
    const { jar: j } = jar({ [SESSION_COOKIE_NAME]: sessionCookie(TOKEN) });
    expect(
      await staffMayBypass(j, {
        now: NOW,
        sessionClient: () => {
          throw new Error('no env');
        },
      }),
    ).toBe(false);
  });
});
