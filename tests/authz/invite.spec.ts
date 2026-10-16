import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { TENANT, UUID } from './harness';

// Accepting an invite (Admin v2 U12b, POST /api/admin/auth/invite). Reached without a session
// and checks no capability: its authority is the one-time invite token, so the endpoint
// matrix cannot drive it (NOT_DRIVABLE in endpointCoverage.spec.ts). Its guards, the reset's
// (tests/authz/recovery.spec.ts) in an invite's terms, are driven here; the middleware in
// front of it is in login.spec.ts (pre-auth, same-origin, the double-submit token).
//   - the token's shape and the password (at least 10 characters, at most 72 bytes; typed
//     twice) are checked before anything is counted or spent, and the form keeps the token;
//   - the limits: per IP address, then the tenant's window for what the first let through,
//     failing closed;
//   - verify (type invite), set the password and clear the invite's message, sign out
//     everywhere, in that order, on a client made for the request;
//   - an account switched off since the invite went out sets no password;
//   - a throttled or unanswered verify keeps the link; a refused or broken set ends the
//     invite's session and the link, and says why in system_logs (never the password);
//   - the browser's own session cookies are cleared; the account's audit row, with no
//     address and no message (decision D5).

const state = vi.hoisted(() => ({
  tenant: '' as string | null,
  counts: new Map<string, number>(),
  limiterUp: true,
  rpcs: [] as { scope: string; key: string }[],
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  profile: null as { tenant_id: string; role: string; is_active: boolean } | null,
  /** The service-role read of the invitee's profile failing (an outage). */
  profileError: null as null | { message: string },
  logs: [] as Record<string, unknown>[],
  clients: [] as unknown[],
  verify: { ok: true, status: 403 },
  update: { error: null as null | { message: string; code?: string; status?: number } },
  updateThrows: false,
  signOutGlobalError: null as null | { message: string },
  calls: [] as string[],
  updates: [] as Record<string, unknown>[],
}));

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    rpc: async (fn: string, args: { p_scope: string; p_key_hash: string }) => {
      if (fn !== 'public_write_hit') return { data: null, error: { message: `no ${fn}` } };
      state.rpcs.push({ scope: args.p_scope, key: args.p_key_hash });
      if (!state.limiterUp) return { data: null, error: { message: 'unreachable' } };
      const id = `${args.p_scope}|${args.p_key_hash}`;
      const next = (state.counts.get(id) ?? 0) + 1;
      state.counts.set(id, next);
      return { data: next, error: null };
    },
    from: (table: string) => {
      const query = {
        select: () => query,
        order: () => query,
        limit: () => query,
        eq: () => query,
        maybeSingle: async () => {
          if (table === 'tenants')
            return { data: state.tenant ? { id: state.tenant } : null, error: null };
          if (table === 'profiles')
            return state.profileError
              ? { data: null, error: state.profileError }
              : { data: state.profile, error: null };
          return { data: null, error: null };
        },
        insert: async (row: Record<string, unknown>) => {
          state.inserts.push({ table, row });
          return { error: null };
        },
      };
      return query;
    },
  }),
}));

vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: Record<string, unknown>) => {
    state.logs.push(entry);
    return true;
  },
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: (_url: string, _key: string, options: { auth: Record<string, unknown> }) => {
    const client = {
      options,
      auth: {
        verifyOtp: async (params: { type: string; token_hash: string }) => {
          state.calls.push(`verify:${params.type}`);
          return state.verify.ok
            ? { data: { session: { access_token: 'a' }, user: { id: UUID } }, error: null }
            : {
                data: { session: null, user: null },
                error: { message: 'refused', status: state.verify.status },
              };
        },
        updateUser: async (attrs: Record<string, unknown>) => {
          state.calls.push(`update:${String(attrs['password']).length}`);
          state.updates.push(attrs);
          if (state.updateThrows) throw new Error('network');
          return { data: {}, error: state.update.error };
        },
        signOut: async (opts: { scope: string }) => {
          state.calls.push(`sign-out:${opts.scope}`);
          return { error: opts.scope === 'global' ? state.signOutGlobalError : null };
        },
      },
    };
    state.clients.push(client);
    return client;
  },
}));

const { POST: INVITE } = (await import('@/pages/api/admin/auth/invite')) as { POST: APIRoute };
const { RECOVERY_LIMITS } = await import('@/lib/auth/recovery');

const TOKEN = 'a1b2c3d4'.repeat(7); // 56 characters, the shape of GoTrue's token hash
const NEW_PASSWORD = 'a long and fresh passphrase';
const ORIGIN = 'https://admin.example.test';
const KEPT = `__Secure-braiin-invite=${TOKEN}; Max-Age=900; Path=/admin/invite; Secure; HttpOnly; SameSite=Strict`;
const DROPPED =
  '__Secure-braiin-invite=; Max-Age=0; Path=/admin/invite; Secure; HttpOnly; SameSite=Strict';

beforeEach(() => {
  state.tenant = TENANT;
  state.counts.clear();
  state.limiterUp = true;
  state.rpcs.length = 0;
  state.inserts.length = 0;
  state.profile = { tenant_id: TENANT, role: 'seo', is_active: true };
  state.profileError = null;
  state.logs.length = 0;
  state.clients.length = 0;
  state.verify = { ok: true, status: 403 };
  state.update = { error: null };
  state.updateThrows = false;
  state.signOutGlobalError = null;
  state.calls.length = 0;
  state.updates.length = 0;
});

async function accept(
  body: Record<string, string> | string,
  options: { form?: boolean; ip?: string } = {},
): Promise<{ res: Response; deleted: string[] }> {
  const form = options.form ?? false;
  const request = new Request(`${ORIGIN}/api/admin/auth/invite`, {
    method: 'POST',
    headers: {
      'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
      'cf-connecting-ip': options.ip ?? '203.0.113.7',
    },
    body:
      typeof body === 'string'
        ? body
        : form
          ? new URLSearchParams(body).toString()
          : JSON.stringify(body),
  });
  const deleted: string[] = [];
  const ctx = {
    request,
    locals: {},
    cookies: {
      get: () => undefined,
      set: () => undefined,
      delete: (name: string) => deleted.push(name),
    },
  };
  const res = (await INVITE(ctx as unknown as Parameters<APIRoute>[0])) as Response;
  return { res, deleted };
}

const good = { token_hash: TOKEN, password: NEW_PASSWORD, confirm: NEW_PASSWORD };
const scopes = () => state.rpcs.map((r) => r.scope);

/** Back to the page with the code alone in the URL, the token in the page's own cookie. */
function expectTokenKept(res: Response, code: string) {
  expect(res.status).toBe(303);
  expect(res.headers.get('location')).toBe(`/admin/invite?error=${code}`);
  expect(res.headers.get('location')).not.toContain(TOKEN);
  expect(res.headers.getSetCookie()).toEqual([KEPT]);
}

function expectTokenDropped(res: Response, code: string) {
  expect(res.status).toBe(303);
  expect(res.headers.get('location')).toBe(`/admin/invite?error=${code}`);
  expect(res.headers.getSetCookie()).toEqual([DROPPED]);
}

describe('POST /api/admin/auth/invite: checks before the token is spent', () => {
  it('refuses a missing or malformed token (400) and calls nothing', async () => {
    for (const token of ['', 'short', `${TOKEN}<script>`, 'x'.repeat(129)]) {
      const { res } = await accept({ ...good, token_hash: token });
      expect(res.status, token).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'invalid-link' });
    }
    expect(state.rpcs).toEqual([]);
    expect(state.calls).toEqual([]);
    const { res } = await accept({ password: NEW_PASSWORD, confirm: NEW_PASSWORD }, { form: true });
    expectTokenDropped(res, 'expired');
  });

  it('answers 400 to a body that is neither JSON nor a form', async () => {
    const { res } = await accept('not json');
    expect(res.status).toBe(400);
    expect(state.calls).toEqual([]);
  });

  it('refuses a password under 10 characters or over 72 bytes, keeping the token', async () => {
    for (const [password, error] of [
      ['ninechars', 'short'],
      ['x'.repeat(73), 'long'],
      ['ب'.repeat(37), 'long'],
    ] as const) {
      const { res } = await accept({ token_hash: TOKEN, password, confirm: password });
      expect(res.status, password).toBe(422);
      expect(await res.json()).toEqual({ ok: false, error });
      const { res: page } = await accept(
        { token_hash: TOKEN, password, confirm: password },
        { form: true },
      );
      expectTokenKept(page, error);
    }
    const { res: missing } = await accept({ token_hash: TOKEN });
    expect(await missing.json()).toEqual({ ok: false, error: 'short' });
    expect(state.rpcs).toEqual([]);
    expect(state.calls).toEqual([]);
  });

  it('refuses two passwords that differ, keeping the token', async () => {
    const { res } = await accept({ ...good, confirm: `${NEW_PASSWORD}!` });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: 'mismatch' });
    const { res: page } = await accept({ ...good, confirm: 'another one!' }, { form: true });
    expectTokenKept(page, 'mismatch');
    expect(state.calls).toEqual([]);
  });

  it(`limits attempts to ${RECOVERY_LIMITS.invitePerIp.max} an hour per address, before verifying`, async () => {
    state.verify = { ok: false, status: 403 };
    for (let i = 0; i < RECOVERY_LIMITS.invitePerIp.max; i++) await accept(good);
    const verifies = state.calls.length;
    const { res } = await accept(good);
    expect(res.status).toBe(429);
    expect(state.calls).toHaveLength(verifies);
    const { res: page } = await accept(good, { form: true });
    expectTokenKept(page, 'limited');
  });

  it("one address cannot spend the tenant's window: what its own limit refused is not counted there", async () => {
    state.verify = { ok: false, status: 403 };
    for (let i = 0; i < RECOVERY_LIMITS.invitePerIp.max + 5; i++) await accept(good);
    expect(scopes().filter((s) => s === 'auth.invite:tenant')).toHaveLength(
      RECOVERY_LIMITS.invitePerIp.max,
    );
  });

  it(`answers 429 past ${RECOVERY_LIMITS.invitePerTenant.max} attempts an hour in all`, async () => {
    state.verify = { ok: false, status: 403 };
    for (let i = 0; i < RECOVERY_LIMITS.invitePerTenant.max; i++) {
      await accept(good, { ip: `198.51.100.${i + 1}` });
    }
    const { res } = await accept(good, { ip: '192.0.2.200' });
    expect(res.status).toBe(429);
  });

  it('fails closed with the limiter down, or no tenant: 503, nothing verified', async () => {
    state.limiterUp = false;
    expect((await accept(good)).res.status).toBe(503);
    state.limiterUp = true;
    state.tenant = null;
    expect((await accept(good)).res.status).toBe(503);
    expect(state.calls).toEqual([]);
  });
});

describe('POST /api/admin/auth/invite: verify, set, sign out everywhere', () => {
  it('a good acceptance runs the steps in order, on a client of its own, and clears the message', async () => {
    const { res, deleted } = await accept(good);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { signedOutEverywhere: true } });
    expect(state.calls).toEqual([
      'verify:invite',
      `update:${NEW_PASSWORD.length}`,
      'sign-out:global',
    ]);
    expect(state.updates).toEqual([{ password: NEW_PASSWORD, data: { invite_message: null } }]);
    expect(state.clients).toHaveLength(1);
    expect(state.clients[0]).toMatchObject({
      options: { auth: { persistSession: false, autoRefreshToken: false, flowType: 'implicit' } },
    });
    expect(deleted).toContain('__Host-braiin-auth');
  });

  it('the form goes to the login page, which says the password is set, and drops the cookie', async () => {
    const { res } = await accept(good, { form: true });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/login?invite=ready');
    expect(res.headers.getSetCookie()).toEqual([DROPPED]);
  });

  it('is audited against the account, in its own tenant, with no address and no message', async () => {
    await accept(good);
    const audit = state.inserts.filter((i) => i.table === 'audit_log');
    expect(audit).toEqual([
      {
        table: 'audit_log',
        row: {
          tenant_id: TENANT,
          actor_id: UUID,
          actor_role: 'seo',
          action: 'auth.invite_accepted',
          entity_type: 'profile',
          entity_id: UUID,
          detail: { ip: '203.0.113.7', signedOutEverywhere: true },
        },
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain(NEW_PASSWORD);
  });

  it('an account switched off since the invite, or without a profile, sets no password', async () => {
    for (const profile of [{ tenant_id: TENANT, role: 'seo', is_active: false }, null]) {
      state.profile = profile;
      state.calls.length = 0;
      state.inserts.length = 0;
      const { res } = await accept(good);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ ok: false, error: 'closed' });
      expect(state.calls).toEqual(['verify:invite', 'sign-out:local']);
      expect(state.inserts.filter((i) => i.table === 'audit_log')).toEqual([]);
      const { res: page } = await accept(good, { form: true });
      expectTokenDropped(page, 'closed');
    }
    expect(state.logs.some((l) => l['source'] === 'auth.invite')).toBe(true);
  });

  it('a profile that cannot be read after the verify is our outage (interrupted), not a closed invite', async () => {
    // The link is spent and the account confirmed, so it cannot be invited again: the page
    // must point at "Forgot password?", never at a new invite the system would refuse.
    state.profileError = { message: 'down' };
    const { res } = await accept(good);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'interrupted' });
    expect(state.calls).toEqual(['verify:invite', 'sign-out:local']);
    expect(state.inserts.filter((i) => i.table === 'audit_log')).toEqual([]);
    const log = state.logs.find((l) => l['source'] === 'auth.invite');
    expect(log).toMatchObject({
      detail: { failure: 'interrupted', userId: UUID, profile: 'unreadable' },
    });
    expectTokenDropped((await accept(good, { form: true })).res, 'interrupted');
  });

  it('a token GoTrue refuses is an invalid link: nothing set, and the form drops the token', async () => {
    state.verify = { ok: false, status: 403 };
    const { res } = await accept(good);
    expect(res.status).toBe(400);
    expect(state.calls).toEqual(['verify:invite']);
    expectTokenDropped((await accept(good, { form: true })).res, 'expired');
  });

  it('a verify GoTrue throttles or cannot answer keeps the link', async () => {
    for (const [status, code, http] of [
      [429, 'limited', 429],
      [500, 'unavailable', 503],
      [0, 'unavailable', 503],
    ] as const) {
      state.verify = { ok: false, status };
      expect((await accept(good)).res.status).toBe(http);
      expectTokenKept((await accept(good, { form: true })).res, code);
    }
    expect(state.calls.every((c) => c === 'verify:invite')).toBe(true);
  });

  it('a password GoTrue refuses ends the session; the link is spent, and the log says why', async () => {
    state.update = { error: { message: 'weak', code: 'weak_password', status: 422 } };
    const { res } = await accept(good);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: 'refused' });
    expect(state.calls).toEqual([
      'verify:invite',
      `update:${NEW_PASSWORD.length}`,
      'sign-out:local',
    ]);
    const log = state.logs.find((l) => l['source'] === 'auth.invite');
    expect(log).toMatchObject({ detail: { failure: 'refused', userId: UUID, status: 422 } });
    expect(JSON.stringify(state.logs)).not.toContain(NEW_PASSWORD);
    expectTokenDropped((await accept(good, { form: true })).res, 'refused');
  });

  it('a set that breaks on the way (5xx, a throw) is spent too', async () => {
    state.update = { error: { message: 'down', status: 502 } };
    expect((await accept(good)).res.status).toBe(503);
    state.update = { error: null };
    state.updateThrows = true;
    const { res } = await accept(good, { form: true });
    expectTokenDropped(res, 'interrupted');
  });

  it('a failed global sign-out is still a set password, logged and audited as such', async () => {
    state.signOutGlobalError = { message: 'down' };
    const { res } = await accept(good);
    expect(await res.json()).toEqual({ ok: true, data: { signedOutEverywhere: false } });
    expect(state.logs.some((l) => l['level'] === 'error')).toBe(true);
    const audit = state.inserts.find((i) => i.table === 'audit_log');
    expect(audit?.row['detail']).toEqual({ ip: '203.0.113.7', signedOutEverywhere: false });
  });

  it('never shares a client between requests', async () => {
    await accept(good);
    await accept(good);
    expect(state.clients).toHaveLength(2);
    expect(state.clients[0]).not.toBe(state.clients[1]);
  });
});
