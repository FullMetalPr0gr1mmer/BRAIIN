import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ROLES, type Role } from '@/lib/auth/types';

// Live-recheck regression suite (CLAUDE.md §9(b)): "demote without refresh → export/lead/
// user-management endpoints 403 immediately".
//
// The property under test is the one documented in src/lib/auth/context.ts: when the claims
// of the token this request carries and the profile row disagree, the session is INVALID
// rather than downgraded. Downgrading only assertCap would leave Postgres RLS (which reads
// the stale token) still enforcing the old, higher role. Since Admin v2 U12a the comparison
// is with the token's own claims, not with the auth server's current user record, and the
// tenant's session length is enforced from the token's sign-in time.
//
// Equally pinned: a valid, current session is NEVER refused. A bug here signs every member
// out on every request, so the happy path is checked for every role, against the token shape
// GoTrue issues, with the auth server's clock ahead of and behind this one.

interface Read {
  data: unknown;
  error: unknown;
}

const { state, logs } = vi.hoisted(() => ({
  state: {
    /** What the read WITH the embedded setting answers. */
    withSetting: { data: null, error: null } as Read,
    /** What the plain profile read answers (the fallback). */
    plain: { data: null, error: null } as Read,
    selects: [] as string[],
  },
  logs: [] as unknown[],
}));

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    from: () => ({
      select: (columns: string) => {
        state.selects.push(columns);
        const answer = columns.includes('tenant:') ? state.withSetting : state.plain;
        const chain = {
          eq: () => chain,
          maybeSingle: async () => answer,
        };
        return chain;
      },
    }),
  }),
}));
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: unknown) => {
    logs.push(entry);
    return true;
  },
}));

const { resolveAuthContext, resetAuthContextLogs, sessionMaxDays, CLOCK_SKEW_SECONDS } =
  await import('@/lib/auth/context');
const { liveRecheck } = await import('@/lib/admin/liveRecheck');

const USER = '11111111-1111-4111-8111-111111111111';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
/** This Worker's clock in the tests: 2026-10-15 12:00:00 UTC. */
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const NOW_S = NOW / 1000;
const HOUR = 3600;
const DAY = 86_400;

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** A JWT as GoTrue signs it (the signature is never read: getUser() is the check). */
function jwt(payload: unknown): string {
  return `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.c2lnbmF0dXJl`;
}

/**
 * The claims of an access token the local GoTrue issues for a password sign-in, with the
 * access-token hook's stamp (0010): the shape pinned here is the one resolveAuthContext reads.
 */
function claims(overrides: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) {
  return {
    aud: 'authenticated',
    exp: NOW_S + HOUR,
    iat: NOW_S,
    iss: 'http://127.0.0.1:54321/auth/v1',
    sub: USER,
    email: 'a@b.test',
    phone: '',
    app_metadata: {
      provider: 'email',
      providers: ['email'],
      role: 'admin',
      tenant_id: TENANT,
      ...meta,
    },
    user_metadata: { email_verified: true },
    role: 'authenticated',
    aal: 'aal1',
    amr: [{ method: 'password', timestamp: NOW_S - HOUR }],
    session_id: '22222222-2222-4222-8222-222222222222',
    is_anonymous: false,
    ...overrides,
  };
}

interface ClientOptions {
  /** The access token in the session; null for no session. */
  token?: string | null;
  /** getUser's answer: the user, or an error (a revoked session: session_not_found). */
  user?: Record<string, unknown> | null;
  userError?: unknown;
}

const calls = { getUser: [] as unknown[], getSession: 0 };

function client(options: ClientOptions = {}): SupabaseClient {
  const token = options.token === undefined ? jwt(claims()) : options.token;
  const user =
    options.user === undefined
      ? // The auth server's CURRENT record. Its app_metadata is never read any more.
        { id: USER, email: 'a@b.test', app_metadata: { role: 'admin', tenant_id: TENANT } }
      : options.user;
  return {
    auth: {
      getSession: async () => {
        calls.getSession += 1;
        return {
          data: { session: token === null ? null : { access_token: token } },
          error: null,
        };
      },
      getUser: async (jwtArg?: string) => {
        calls.getUser.push(jwtArg);
        return options.userError
          ? { data: { user: null }, error: options.userError }
          : { data: { user }, error: null };
      },
    },
  } as unknown as SupabaseClient;
}

/** A profile row as the service role reads it, with the tenant's session length embedded. */
function profile(
  role: string,
  {
    tenant = TENANT,
    active = true,
    lockedUntil = null as string | null,
    days = undefined as number | null | undefined,
  } = {},
): Read {
  return {
    data: {
      tenant_id: tenant,
      role,
      is_active: active,
      locked_until: lockedUntil,
      tenant: { security: days === undefined || days === null ? null : { session_max_days: days } },
    },
    error: null,
  };
}

function setProfile(read: Read) {
  state.withSetting = read;
  const data = read.data as Record<string, unknown> | null;
  if (data) {
    const { tenant: _setting, ...plain } = data;
    state.plain = { data: plain, error: null };
  } else {
    state.plain = read;
  }
}

const resolve = (c: SupabaseClient, now = NOW) => resolveAuthContext(c, now);

beforeEach(() => {
  setProfile(profile('admin'));
  state.selects = [];
  logs.length = 0;
  calls.getUser = [];
  calls.getSession = 0;
  resetAuthContextLogs();
});

describe('resolveAuthContext: a valid, current session is never refused', () => {
  it.each(ROLES)('%s, its token and profile agreeing, gets a context', async (role) => {
    setProfile(profile(role));
    const result = await resolve(client({ token: jwt(claims({}, { role })) }));
    expect(result).toEqual({
      ctx: { userId: USER, tenantId: TENANT, role, isActive: true, email: 'a@b.test' },
      revoke: false,
    });
  });

  it('asks the auth server about exactly the token it then reads, once each, one profile read', async () => {
    const token = jwt(claims());
    await resolve(client({ token }));
    expect(calls.getSession).toBe(1);
    expect(calls.getUser).toEqual([token]);
    expect(state.selects).toEqual([
      'tenant_id,role,is_active,locked_until,tenant:tenants(security:admin_security_settings(session_max_days))',
    ]);
  });

  it('reads the role from the token, not from the auth server’s current record', async () => {
    // A token minted after the change carries the new role; the user record may lag (or
    // lead) it. Before U12a the record was compared, and a lagging one locked people out.
    setProfile(profile('seo'));
    const result = await resolve(
      client({
        token: jwt(claims({}, { role: 'seo' })),
        user: { id: USER, email: 'a@b.test', app_metadata: { role: 'admin', tenant_id: TENANT } },
      }),
    );
    expect(result.ctx?.role).toBe('seo');
  });

  it('decodes a token whose user data is not ASCII', async () => {
    const token = jwt(claims({ user_metadata: { full_name: 'سارة', email_verified: true } }));
    expect((await resolve(client({ token }))).ctx).not.toBeNull();
  });

  it('a token signed in moments ago by an auth server whose clock runs ahead', async () => {
    const token = jwt(claims({ amr: [{ method: 'password', timestamp: NOW_S + 120 }] }));
    expect((await resolve(client({ token }))).ctx).not.toBeNull();
  });

  it('a token this Worker thinks expired a few seconds ago (its clock runs ahead)', async () => {
    const token = jwt(claims({ exp: NOW_S - 30 }));
    expect((await resolve(client({ token }))).ctx).not.toBeNull();
  });

  it('a 7-day tenant keeps a 2-day-old sign-in, and so does a tenant with no setting', async () => {
    const twoDays = jwt(claims({ amr: [{ method: 'password', timestamp: NOW_S - 2 * DAY }] }));
    setProfile(profile('admin', { days: 7 }));
    expect((await resolve(client({ token: twoDays }))).ctx).not.toBeNull();
    setProfile(profile('admin', { days: null }));
    expect((await resolve(client({ token: twoDays }))).ctx).not.toBeNull();
  });

  it('counts the session length from the NEWEST sign-in the token records', async () => {
    // A password 8 days ago and a second factor an hour ago: the person proved who they are
    // an hour ago.
    const token = jwt(
      claims({
        amr: [
          { method: 'password', timestamp: NOW_S - 8 * DAY },
          { method: 'totp', timestamp: NOW_S - HOUR },
        ],
      }),
    );
    expect((await resolve(client({ token }))).ctx).not.toBeNull();
  });

  it('lets a token with no sign-in time through, unchecked, and says so once per isolate', async () => {
    const noAmr = { ...claims() } as Record<string, unknown>;
    delete noAmr['amr'];
    const old = jwt(noAmr);
    expect((await resolve(client({ token: old }))).ctx).not.toBeNull();
    expect((await resolve(client({ token: old }))).ctx).not.toBeNull();
    // RFC 8176's bare strings carry no time either; a malformed amr is treated the same.
    expect((await resolve(client({ token: jwt(claims({ amr: ['pwd'] })) }))).ctx).not.toBeNull();
    expect((await resolve(client({ token: jwt(claims({ amr: { x: 1 } })) }))).ctx).not.toBeNull();
    expect(logs).toEqual([
      {
        level: 'warn',
        source: 'auth:session',
        message: 'access token without a sign-in time; session age not checked',
      },
    ]);
  });

  it('when the setting cannot be read with the profile, reads the profile alone: 7 days, logged once', async () => {
    state.withSetting = { data: null, error: { message: 'Could not find a relationship' } };
    state.plain = {
      data: { tenant_id: TENANT, role: 'admin', is_active: true, locked_until: null },
      error: null,
    };
    const sixDays = jwt(claims({ amr: [{ method: 'password', timestamp: NOW_S - 6 * DAY }] }));
    expect((await resolve(client({ token: sixDays }))).ctx).not.toBeNull();
    expect((await resolve(client({ token: sixDays }))).ctx).not.toBeNull();
    expect(state.selects.filter((s) => !s.includes('tenant:'))).toHaveLength(2);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: 'warn', source: 'auth:session' });
    // ...and the 7-day default still ends an 8-day-old sign-in.
    const eightDays = jwt(claims({ amr: [{ method: 'password', timestamp: NOW_S - 8 * DAY }] }));
    expect(await resolve(client({ token: eightDays }))).toEqual({ ctx: null, revoke: true });
  });

  it('reads an embedded setting PostgREST returns as a one-row list', () => {
    expect(sessionMaxDays({ tenant: [{ security: [{ session_max_days: 1 }] }] })).toBe(1);
    expect(sessionMaxDays({ tenant: { security: { session_max_days: 1 } } })).toBe(1);
    expect(sessionMaxDays({ tenant: { security: null } })).toBe(7);
    expect(sessionMaxDays({})).toBe(7);
    // Anything the column could not hold falls back to the default, never to "no limit".
    for (const odd of [0, 8, 30, 1.5, '1', null, -1]) {
      expect(sessionMaxDays({ tenant: { security: { session_max_days: odd } } })).toBe(7);
    }
  });

  it('admits a locked account again once the lock has passed', async () => {
    setProfile(profile('admin', { lockedUntil: new Date(NOW - 600_000).toISOString() }));
    expect((await resolve(client())).ctx).not.toBeNull();
  });
});

describe('resolveAuthContext: no session is anonymous, not something to revoke', () => {
  it('no session in the cookie: the auth server is not even asked', async () => {
    expect(await resolve(client({ token: null }))).toEqual({ ctx: null, revoke: false });
    expect(calls.getUser).toEqual([]);
  });

  it('a session the auth server no longer knows (revoked: session_not_found)', async () => {
    const result = await resolve(
      client({ userError: { name: 'AuthSessionMissingError', status: 403 }, user: null }),
    );
    expect(result).toEqual({ ctx: null, revoke: false });
  });

  it('a token with no role or no tenant claim (the hook did not stamp it)', async () => {
    const noRole = jwt(claims({}, { role: undefined }));
    expect(await resolve(client({ token: noRole }))).toEqual({ ctx: null, revoke: false });
    const noTenant = jwt(claims({}, { tenant_id: undefined }));
    expect(await resolve(client({ token: noTenant }))).toEqual({ ctx: null, revoke: false });
  });

  it('a role only in user_metadata, which the user can write, is never honoured', async () => {
    const token = jwt(
      claims({ user_metadata: { role: 'admin', tenant_id: TENANT } }, { role: undefined }),
    );
    expect((await resolve(client({ token }))).ctx).toBeNull();
  });
});

describe('resolveAuthContext: a stale or too-old session is REVOKED', () => {
  const pairs = ROLES.flatMap((from) =>
    ROLES.filter((to) => to !== from).map((to) => [from, to] as [Role, Role]),
  );
  it.each(pairs)('a token minted as %s just before the role changed to %s', async (from, to) => {
    setProfile(profile(to));
    const result = await resolve(client({ token: jwt(claims({}, { role: from })) }));
    // Not "downgraded": denied. RLS would still enforce the token's role.
    expect(result).toEqual({ ctx: null, revoke: true });
  });

  it('even when the auth server’s current record already shows the new role', async () => {
    // The users screen rewrites app_metadata with the profile, so the record agrees with the
    // profile at once; the TOKEN is what RLS reads, and it still says admin.
    setProfile(profile('seo'));
    const result = await resolve(
      client({
        token: jwt(claims({}, { role: 'admin' })),
        user: { id: USER, email: 'a@b.test', app_metadata: { role: 'seo', tenant_id: TENANT } },
      }),
    );
    expect(result).toEqual({ ctx: null, revoke: true });
  });

  it('a token of another tenant than the profile', async () => {
    setProfile(profile('admin', { tenant: OTHER_TENANT }));
    expect(await resolve(client())).toEqual({ ctx: null, revoke: true });
  });

  it('a token that is not the verified user’s', async () => {
    const token = jwt(claims({ sub: '33333333-3333-4333-8333-333333333333' }));
    expect(await resolve(client({ token }))).toEqual({ ctx: null, revoke: true });
  });

  it.each([
    ['not a JWT', 'garbage'],
    ['two segments', 'a.b'],
    ['a payload that is not base64url', 'a.!!!.c'],
    ['a payload that is not JSON', `a.${b64url('not json')}.c`],
    ['a payload that is a list', `a.${b64url('[1,2]')}.c`],
    ['no sub', jwt({ ...claims(), sub: undefined })],
    ['an exp that is text', jwt({ ...claims(), exp: String(NOW_S + HOUR) })],
  ])('a verified token that will not decode (%s)', async (_label, token) => {
    expect(await resolve(client({ token }))).toEqual({ ctx: null, revoke: true });
  });

  it('a token past its expiry by more than the clock allowance', async () => {
    const token = jwt(claims({ exp: NOW_S - CLOCK_SKEW_SECONDS - 1 }));
    expect(await resolve(client({ token }))).toEqual({ ctx: null, revoke: true });
  });

  it('a 1-day tenant ends a 2-day-old sign-in, and keeps a 23-hour-old one', async () => {
    setProfile(profile('admin', { days: 1 }));
    const twoDays = jwt(claims({ amr: [{ method: 'password', timestamp: NOW_S - 2 * DAY }] }));
    expect(await resolve(client({ token: twoDays }))).toEqual({ ctx: null, revoke: true });
    const hours23 = jwt(claims({ amr: [{ method: 'password', timestamp: NOW_S - 23 * HOUR }] }));
    expect((await resolve(client({ token: hours23 }))).ctx).not.toBeNull();
  });

  it('the boundary: the length plus the clock allowance is kept, a second more is not', async () => {
    setProfile(profile('admin', { days: 1 }));
    const at = (age: number) =>
      jwt(claims({ amr: [{ method: 'password', timestamp: NOW_S - age }] }));
    expect((await resolve(client({ token: at(DAY + CLOCK_SKEW_SECONDS) }))).ctx).not.toBeNull();
    expect(await resolve(client({ token: at(DAY + CLOCK_SKEW_SECONDS + 1) }))).toEqual({
      ctx: null,
      revoke: true,
    });
  });

  it('a tenant with no setting ends a sign-in older than 7 days', async () => {
    setProfile(profile('admin', { days: null }));
    const token = jwt(claims({ amr: [{ method: 'password', timestamp: NOW_S - 8 * DAY }] }));
    expect(await resolve(client({ token }))).toEqual({ ctx: null, revoke: true });
  });

  it('a deactivated account', async () => {
    setProfile(profile('admin', { active: false }));
    expect(await resolve(client())).toEqual({ ctx: null, revoke: true });
  });

  it('a locked account', async () => {
    setProfile(profile('admin', { lockedUntil: new Date(NOW + 600_000).toISOString() }));
    expect(await resolve(client())).toEqual({ ctx: null, revoke: true });
  });

  it('FAILS CLOSED when the profile is unreadable, the setting and the plain read alike', async () => {
    // An outage in the component that answers "is this person still allowed" must not
    // become permission. Falling back to the token here would silently re-enable every
    // account that had just been disabled.
    state.withSetting = { data: null, error: { message: 'connection refused' } };
    state.plain = { data: null, error: { message: 'connection refused' } };
    expect(await resolve(client())).toEqual({ ctx: null, revoke: true });
  });

  it('FAILS CLOSED when the profile row has vanished', async () => {
    setProfile({ data: null, error: null });
    expect(await resolve(client())).toEqual({ ctx: null, revoke: true });
  });
});

describe('liveRecheck (privileged endpoints)', () => {
  const ctx = {
    userId: USER,
    tenantId: TENANT,
    role: 'developer' as const,
    isActive: true,
    email: 'd@b.test',
  };
  const plain = (data: unknown, error: unknown = null) => {
    state.plain = { data, error };
  };

  it('passes when the profile still agrees', async () => {
    plain({ role: 'developer', is_active: true, locked_until: null });
    await expect(liveRecheck(ctx)).resolves.toBeUndefined();
  });

  it('throws the moment the role has changed under an open session', async () => {
    plain({ role: 'content_creator', is_active: true, locked_until: null });
    await expect(liveRecheck(ctx)).rejects.toThrow(/role changed/);
  });

  it('throws for a deactivated account', async () => {
    plain({ role: 'developer', is_active: false, locked_until: null });
    await expect(liveRecheck(ctx)).rejects.toThrow(/disabled/);
  });

  it('throws for a locked account', async () => {
    const future = new Date(Date.now() + 600_000).toISOString();
    plain({ role: 'developer', is_active: true, locked_until: future });
    await expect(liveRecheck(ctx)).rejects.toThrow(/locked/);
  });

  it('throws — never passes — when the check itself fails', async () => {
    plain(null, { message: 'down' });
    await expect(liveRecheck(ctx)).rejects.toThrow(/unreadable/);
  });
});
