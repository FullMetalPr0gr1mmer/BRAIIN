import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import { PUBLIC_SITE_URL } from '../stubs/astro-env-client';
import { TENANT, UUID } from './harness';

// Forgot and reset password (Admin v2 F7, docs/admin-v2/ui.md AV-06). Neither endpoint
// checks a capability (forgot answers anyone; reset's authority is the one-time token), so
// the endpoint matrix cannot drive them (NOT_DRIVABLE in endpointCoverage.spec.ts). Their
// guards are driven here; the middleware in front of them is in login.spec.ts (pre-auth,
// same-origin, the double-submit token).
//
// Forgot (CLAUDE.md §3 "no enumeration"):
//   - while e-mail is not set up (owner item O-2) every request gets "Not set up", and
//     nothing is counted, sent or audited;
//   - set up, a known address, an unknown one and a malformed one get the same status, the
//     same body and the same page, and the answer does not wait for the e-mail (waitUntil);
//   - limits per IP address, per e-mail (an HMAC) and per tenant, failing closed;
//   - one audit row per accepted request, with no actor and nothing about the requester.
// Reset:
//   - the token's shape and the password (12 to 128 characters, typed twice) are checked
//     before anything is counted or spent, and the form keeps the token for a retry;
//   - a per-IP limit, failing closed;
//   - verify, set, sign out everywhere, in that order, on a client made for the request;
//   - a refused password ends the recovery session and the link;
//   - the browser's own session cookies are cleared; the account's audit row.

const state = vi.hoisted(() => ({
  emailReady: true,
  tenant: '' as string | null,
  /** Limiter counts per scope + key, as public_write_hit returns them. */
  counts: new Map<string, number>(),
  limiterUp: true,
  rpcs: [] as { scope: string; key: string }[],
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  auditFails: false,
  profile: null as { tenant_id: string; role: string } | null,
  logs: [] as Record<string, unknown>[],
  /** Every recovery client created, in order. */
  clients: [] as unknown[],
  /** Addresses GoTrue knows (reset e-mails to others are silently dropped by GoTrue). */
  known: new Set<string>(),
  sendGate: null as Promise<void> | null,
  sent: [] as { email: string; redirectTo: string | undefined }[],
  verify: { ok: true, status: 403 },
  update: { error: null as null | { message: string; code?: string; status?: number } },
  updateThrows: false,
  signOutGlobalError: null as null | { message: string },
  calls: [] as string[],
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
          if (table === 'profiles') return { data: state.profile, error: null };
          return { data: null, error: null };
        },
        insert: async (row: Record<string, unknown>) => {
          state.inserts.push({ table, row });
          return { error: state.auditFails ? { code: '42501', message: 'denied' } : null };
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

// The recovery client: createClient is called once per recovery request.
vi.mock('@supabase/supabase-js', () => ({
  createClient: (_url: string, _key: string, options: { auth: Record<string, unknown> }) => {
    const client = {
      options,
      auth: {
        resetPasswordForEmail: async (email: string, opts?: { redirectTo?: string }) => {
          state.calls.push('reset-email');
          if (state.sendGate) await state.sendGate;
          if (!state.known.has(email)) return { data: {}, error: null };
          state.sent.push({ email, redirectTo: opts?.redirectTo });
          return { data: {}, error: null };
        },
        verifyOtp: async (params: { type: string; token_hash: string }) => {
          state.calls.push(`verify:${params.type}`);
          return state.verify.ok
            ? { data: { session: { access_token: 'a' }, user: { id: UUID } }, error: null }
            : {
                data: { session: null, user: null },
                error: { message: 'refused', status: state.verify.status },
              };
        },
        updateUser: async (attrs: { password: string }) => {
          state.calls.push(`update:${attrs.password.length}`);
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

vi.mock('@/lib/auth/recovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/recovery')>()),
  authEmailReady: () => state.emailReady,
}));

const { POST: FORGOT } = (await import('@/pages/api/admin/auth/forgot')) as { POST: APIRoute };
const { POST: RESET } = (await import('@/pages/api/admin/auth/reset')) as { POST: APIRoute };
const { RECOVERY_LIMITS } = await import('@/lib/auth/recovery');

beforeEach(() => {
  state.emailReady = true;
  state.tenant = TENANT;
  state.counts.clear();
  state.limiterUp = true;
  state.rpcs.length = 0;
  state.inserts.length = 0;
  state.auditFails = false;
  state.profile = { tenant_id: TENANT, role: 'seo' };
  state.logs.length = 0;
  state.clients.length = 0;
  state.known = new Set(['staff@example.test']);
  state.sendGate = null;
  state.sent.length = 0;
  state.verify = { ok: true, status: 403 };
  state.updateThrows = false;
  state.update = { error: null };
  state.signOutGlobalError = null;
  state.calls.length = 0;
});

const ORIGIN = 'https://admin.example.test';

interface Sent {
  res: Response;
  waited: Promise<unknown>[];
  deleted: { name: string; options: Record<string, unknown> }[];
}

async function call(
  route: APIRoute,
  path: string,
  body: Record<string, string> | string,
  options: { form?: boolean; ip?: string } = {},
): Promise<Sent> {
  const form = options.form ?? false;
  const request = new Request(`${ORIGIN}${path}`, {
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
  const waited: Promise<unknown>[] = [];
  const deleted: { name: string; options: Record<string, unknown> }[] = [];
  const ctx = {
    request,
    locals: { cfContext: { waitUntil: (p: Promise<unknown>) => waited.push(p) } },
    cookies: {
      get: () => undefined,
      set: () => undefined,
      delete: (name: string, options: Record<string, unknown>) => deleted.push({ name, options }),
    },
  };
  const res = (await route(ctx as unknown as Parameters<APIRoute>[0])) as Response;
  return { res, waited, deleted };
}

const forgot = (body: Record<string, string> | string, options?: { form?: boolean; ip?: string }) =>
  call(FORGOT, '/api/admin/auth/forgot', body, options);
const reset = (body: Record<string, string> | string, options?: { form?: boolean; ip?: string }) =>
  call(RESET, '/api/admin/auth/reset', body, options);

const scopes = () => state.rpcs.map((r) => r.scope);

// ── Forgot ───────────────────────────────────────────────────────────────────────

describe('POST /api/admin/auth/forgot while e-mail is not set up (owner item O-2)', () => {
  it('answers "not set up" to everyone, and counts, sends and audits nothing', async () => {
    state.emailReady = false;
    const answers: string[] = [];
    for (const email of ['staff@example.test', 'nobody@example.test', 'not an address']) {
      const { res, waited } = await forgot({ email });
      expect(res.status).toBe(503);
      answers.push(await res.text());
      expect(waited).toEqual([]);
    }
    expect(new Set(answers)).toEqual(new Set([JSON.stringify({ ok: false, error: 'not-set-up' })]));
    expect(state.rpcs).toEqual([]);
    expect(state.calls).toEqual([]);
    expect(state.inserts).toEqual([]);
  });

  it('sends the form back to the page, which says so itself', async () => {
    state.emailReady = false;
    const { res } = await forgot({ email: 'staff@example.test' }, { form: true });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/forgot');
  });
});

describe('POST /api/admin/auth/forgot: one answer for every address', () => {
  it('a known, an unknown and a malformed address get the same status and body', async () => {
    const answers: string[] = [];
    for (const email of ['staff@example.test', 'nobody@example.test', 'not an address', '']) {
      const { res, waited } = await forgot({ email });
      expect(res.status, email).toBe(200);
      answers.push(await res.text());
      await Promise.all(waited);
    }
    expect(new Set(answers)).toEqual(
      new Set([JSON.stringify({ ok: true, data: { accepted: true } })]),
    );
    // Only the two addresses were handed to GoTrue; only the known one got an e-mail.
    expect(state.calls).toEqual(['reset-email', 'reset-email']);
    expect(state.sent).toEqual([
      { email: 'staff@example.test', redirectTo: `${PUBLIC_SITE_URL}/admin/reset` },
    ]);
  });

  it('and the same page to a form post', async () => {
    const locations: (string | null)[] = [];
    for (const email of ['staff@example.test', 'nobody@example.test', 'nope']) {
      const { res } = await forgot({ email }, { form: true });
      expect(res.status).toBe(303);
      locations.push(res.headers.get('location'));
    }
    expect(new Set(locations)).toEqual(new Set(['/admin/forgot?status=sent']));
  });

  it('answers before the e-mail is sent: the send runs after the response (waitUntil)', async () => {
    let release!: () => void;
    state.sendGate = new Promise<void>((resolve) => (release = resolve));
    const { res, waited } = await forgot({ email: 'staff@example.test' });
    expect(res.status).toBe(200);
    expect(waited).toHaveLength(1);
    expect(state.sent).toEqual([]);
    release();
    await Promise.all(waited);
    expect(state.sent).toHaveLength(1);
  });

  it('asks Supabase on a client of its own, in the implicit flow, holding nothing', async () => {
    const { waited } = await forgot({ email: 'staff@example.test' });
    await Promise.all(waited);
    expect(state.clients).toHaveLength(1);
    expect(
      (state.clients[0] as { options: { auth: Record<string, unknown> } }).options.auth,
    ).toEqual({
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: 'implicit',
    });
  });

  it('logs a failed send to system_logs without the address', async () => {
    const { waited } = await forgot({ email: 'staff@example.test' });
    await Promise.all(waited);
    expect(state.logs).toEqual([]);

    // GoTrue failing (an SMTP outage, a thrown network error) is never visible to the caller.
    state.sendGate = Promise.reject(new Error('smtp down'));
    state.sendGate.catch(() => undefined);
    const { res, waited: later } = await forgot(
      { email: 'staff@example.test' },
      { ip: '198.51.100.1' },
    );
    expect(res.status).toBe(200);
    await Promise.all(later);
    expect(state.logs).toHaveLength(1);
    expect(JSON.stringify(state.logs)).not.toContain('staff@example.test');
    expect(state.logs[0]).toMatchObject({ level: 'warn', source: 'auth.forgot' });
  });

  it('audits each accepted request once, with no actor and nothing about the requester', async () => {
    await forgot({ email: 'staff@example.test' });
    await forgot({ email: 'nobody@example.test' });
    expect(state.inserts).toEqual([
      {
        table: 'audit_log',
        row: {
          tenant_id: TENANT,
          actor_id: null,
          actor_role: null,
          action: 'auth.password_reset_requested',
          entity_type: 'auth',
          entity_id: null,
          detail: {},
        },
      },
      expect.objectContaining({ table: 'audit_log' }),
    ]);
    expect(JSON.stringify(state.inserts)).not.toMatch(/example\.test|203\.0\.113\.7/);
  });

  it('answers 400 to a body that is neither JSON nor a form, before anything else', async () => {
    const { res } = await forgot('not json');
    expect(res.status).toBe(400);
    expect(state.rpcs).toEqual([]);
  });
});

describe('POST /api/admin/auth/forgot: the limits (fail closed)', () => {
  it('counts per IP address, per e-mail and per tenant, never the raw values', async () => {
    await forgot({ email: 'staff@example.test' });
    expect(scopes()).toEqual(['auth.forgot:ip', 'auth.forgot:email', 'auth.forgot:tenant']);
    for (const { key } of state.rpcs) expect(key).toMatch(/^[0-9a-f]{64}$/);
    // A malformed address is no e-mail to count.
    state.rpcs.length = 0;
    await forgot({ email: 'not an address' }, { ip: '198.51.100.2' });
    expect(scopes()).toEqual(['auth.forgot:ip', 'auth.forgot:tenant']);
  });

  it(`answers 429 past ${RECOVERY_LIMITS.forgotPerIp.max} requests an hour from one address`, async () => {
    for (let i = 0; i < RECOVERY_LIMITS.forgotPerIp.max; i++) {
      const { res } = await forgot({ email: `person${i}@example.test` });
      expect(res.status).toBe(200);
    }
    const sendsBefore = state.calls.length;
    const { res, waited } = await forgot({ email: 'staff@example.test' });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: 'rate-limited' });
    expect(waited).toEqual([]);
    expect(state.calls).toHaveLength(sendsBefore);
    const { res: page } = await forgot({ email: 'staff@example.test' }, { form: true });
    expect(page.headers.get('location')).toBe('/admin/forgot?status=limited');
  });

  it(`answers 429 past ${RECOVERY_LIMITS.forgotPerEmail.max} requests an hour for one e-mail`, async () => {
    for (let i = 0; i < RECOVERY_LIMITS.forgotPerEmail.max; i++) {
      const { res } = await forgot({ email: 'staff@example.test' }, { ip: `198.51.100.${i}` });
      expect(res.status).toBe(200);
    }
    const { res } = await forgot({ email: 'staff@example.test' }, { ip: '198.51.100.99' });
    expect(res.status).toBe(429);
  });

  it(`answers 429 past ${RECOVERY_LIMITS.forgotPerTenant.max} requests an hour in all`, async () => {
    for (let i = 0; i < RECOVERY_LIMITS.forgotPerTenant.max; i++) {
      await forgot({ email: `p${i}@example.test` }, { ip: `10.0.${Math.floor(i / 4)}.${i}` });
    }
    const { res } = await forgot({ email: 'staff@example.test' }, { ip: '192.0.2.200' });
    expect(res.status).toBe(429);
  });

  it('fails closed: with the limiter down it sends and audits nothing (503)', async () => {
    state.limiterUp = false;
    const { res, waited } = await forgot({ email: 'staff@example.test' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'unavailable' });
    expect(waited).toEqual([]);
    expect(state.inserts).toEqual([]);
    const { res: page } = await forgot({ email: 'staff@example.test' }, { form: true });
    expect(page.headers.get('location')).toBe('/admin/forgot?status=unavailable');
  });

  it('fails closed when no tenant resolves', async () => {
    state.tenant = null;
    const { res } = await forgot({ email: 'staff@example.test' });
    expect(res.status).toBe(503);
    expect(state.calls).toEqual([]);
  });
});

// ── Reset ────────────────────────────────────────────────────────────────────────

const TOKEN = 'a1b2c3d4'.repeat(7); // 56 characters, the shape of GoTrue's token hash
const NEW_PASSWORD = 'a long and fresh passphrase';

describe('POST /api/admin/auth/reset: checks before the token is spent', () => {
  it('refuses a missing or malformed token (400) and calls nothing', async () => {
    for (const token of ['', 'short', `${TOKEN}<script>`, 'x'.repeat(129)]) {
      const { res } = await reset({
        token_hash: token,
        password: NEW_PASSWORD,
        confirm: NEW_PASSWORD,
      });
      expect(res.status, token).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'invalid-link' });
    }
    expect(state.rpcs).toEqual([]);
    expect(state.calls).toEqual([]);
    const { res } = await reset({ password: NEW_PASSWORD, confirm: NEW_PASSWORD }, { form: true });
    expect(res.headers.get('location')).toBe('/admin/reset?error=expired');
  });

  it('refuses a password under 12 or over 128 characters, keeping the token for a retry', async () => {
    for (const password of ['elevenchars', 'x'.repeat(129)]) {
      const { res } = await reset({ token_hash: TOKEN, password, confirm: password });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ ok: false, error: 'length' });
    }
    const { res } = await reset(
      { token_hash: TOKEN, password: 'short', confirm: 'short' },
      { form: true },
    );
    expect(res.headers.get('location')).toBe(
      `/admin/reset?token_hash=${TOKEN}&type=recovery&error=length`,
    );
    expect(state.rpcs).toEqual([]);
    expect(state.calls).toEqual([]);
  });

  it('refuses two passwords that differ, keeping the token', async () => {
    const { res } = await reset({
      token_hash: TOKEN,
      password: NEW_PASSWORD,
      confirm: `${NEW_PASSWORD}!`,
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: 'mismatch' });
    const { res: page } = await reset(
      { token_hash: TOKEN, password: NEW_PASSWORD, confirm: 'other password!' },
      { form: true },
    );
    expect(page.headers.get('location')).toBe(
      `/admin/reset?token_hash=${TOKEN}&type=recovery&error=mismatch`,
    );
    expect(state.calls).toEqual([]);
  });

  it(`limits attempts to ${RECOVERY_LIMITS.resetPerIp.max} an hour per address, before verifying`, async () => {
    state.verify = { ok: false, status: 403 };
    for (let i = 0; i < RECOVERY_LIMITS.resetPerIp.max; i++) {
      await reset({ token_hash: TOKEN, password: NEW_PASSWORD, confirm: NEW_PASSWORD });
    }
    const verifies = state.calls.length;
    const { res } = await reset({
      token_hash: TOKEN,
      password: NEW_PASSWORD,
      confirm: NEW_PASSWORD,
    });
    expect(res.status).toBe(429);
    expect(state.calls).toHaveLength(verifies);
    expect(scopes().every((s) => s === 'auth.reset:ip')).toBe(true);
    const { res: page } = await reset(
      { token_hash: TOKEN, password: NEW_PASSWORD, confirm: NEW_PASSWORD },
      { form: true },
    );
    expect(page.headers.get('location')).toBe(
      `/admin/reset?token_hash=${TOKEN}&type=recovery&error=limited`,
    );
  });

  it('fails closed with the limiter down: 503, nothing verified', async () => {
    state.limiterUp = false;
    const { res } = await reset({
      token_hash: TOKEN,
      password: NEW_PASSWORD,
      confirm: NEW_PASSWORD,
    });
    expect(res.status).toBe(503);
    expect(state.calls).toEqual([]);
  });
});

describe('POST /api/admin/auth/reset: verify, set, sign out everywhere', () => {
  it('a good reset runs the three steps in order, on a client of its own', async () => {
    const { res, deleted } = await reset({
      token_hash: TOKEN,
      password: NEW_PASSWORD,
      confirm: NEW_PASSWORD,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { signedOutEverywhere: true } });
    expect(state.calls).toEqual([
      'verify:recovery',
      `update:${NEW_PASSWORD.length}`,
      'sign-out:global',
    ]);
    expect(state.clients).toHaveLength(1);
    // This browser's session cookies go too, with deletions a browser accepts.
    expect(deleted.map((d) => d.name)).toContain('__Host-braiin-auth');
    for (const { options } of deleted) expect(options).toMatchObject({ secure: true, path: '/' });
  });

  it('the form goes to the login page, which says the password changed', async () => {
    const { res } = await reset(
      { token_hash: TOKEN, password: NEW_PASSWORD, confirm: NEW_PASSWORD },
      { form: true },
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/login?reset=done');
  });

  it('is audited against the account, in its own tenant, with the sign-out outcome', async () => {
    await reset({ token_hash: TOKEN, password: NEW_PASSWORD, confirm: NEW_PASSWORD });
    const audit = state.inserts.filter((i) => i.table === 'audit_log');
    expect(audit).toEqual([
      {
        table: 'audit_log',
        row: {
          tenant_id: TENANT,
          actor_id: UUID,
          actor_role: 'seo',
          action: 'auth.password_reset',
          entity_type: 'profile',
          entity_id: UUID,
          detail: { ip: '203.0.113.7', signedOutEverywhere: true },
        },
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain(NEW_PASSWORD);
  });

  it('a token GoTrue refuses is an invalid link: nothing set, and the form drops the token', async () => {
    state.verify = { ok: false, status: 403 };
    const { res } = await reset({
      token_hash: TOKEN,
      password: NEW_PASSWORD,
      confirm: NEW_PASSWORD,
    });
    expect(res.status).toBe(400);
    expect(state.calls).toEqual(['verify:recovery']);
    const { res: page } = await reset(
      { token_hash: TOKEN, password: NEW_PASSWORD, confirm: NEW_PASSWORD },
      { form: true },
    );
    expect(page.headers.get('location')).toBe('/admin/reset?error=expired');
    expect(state.inserts).toEqual([]);
  });

  it('a password GoTrue refuses ends the recovery session; the link is spent', async () => {
    state.update = { error: { message: 'weak', code: 'weak_password', status: 422 } };
    const { res } = await reset({
      token_hash: TOKEN,
      password: NEW_PASSWORD,
      confirm: NEW_PASSWORD,
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: 'refused' });
    expect(state.calls).toEqual([
      'verify:recovery',
      `update:${NEW_PASSWORD.length}`,
      'sign-out:local',
    ]);
    expect(state.inserts).toEqual([]);
    const { res: page } = await reset(
      { token_hash: TOKEN, password: NEW_PASSWORD, confirm: NEW_PASSWORD },
      { form: true },
    );
    expect(page.headers.get('location')).toBe('/admin/reset?error=refused');
  });

  it('a failed global sign-out is still a changed password, logged and audited as such', async () => {
    state.signOutGlobalError = { message: 'network' };
    const { res } = await reset({
      token_hash: TOKEN,
      password: NEW_PASSWORD,
      confirm: NEW_PASSWORD,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { signedOutEverywhere: false } });
    expect(state.logs).toEqual([expect.objectContaining({ level: 'error', source: 'auth.reset' })]);
    expect(state.inserts[0]?.row).toMatchObject({ detail: { signedOutEverywhere: false } });
  });

  it('an account with no profile is audited in the launch tenant with no role', async () => {
    state.profile = null;
    await reset({ token_hash: TOKEN, password: NEW_PASSWORD, confirm: NEW_PASSWORD });
    expect(state.inserts[0]?.row).toMatchObject({ tenant_id: TENANT, actor_role: null });
  });

  it('a lost audit row is reported to system_logs, and the reset still stands', async () => {
    state.auditFails = true;
    const { res } = await reset({
      token_hash: TOKEN,
      password: NEW_PASSWORD,
      confirm: NEW_PASSWORD,
    });
    expect(res.status).toBe(200);
    expect(state.logs).toEqual([expect.objectContaining({ level: 'error', source: 'audit' })]);
  });

  it('never shares a client between requests', async () => {
    await reset({ token_hash: TOKEN, password: NEW_PASSWORD, confirm: NEW_PASSWORD });
    await reset(
      { token_hash: TOKEN, password: NEW_PASSWORD, confirm: NEW_PASSWORD },
      { ip: '192.0.2.9' },
    );
    expect(state.clients).toHaveLength(2);
    expect(state.clients[0]).not.toBe(state.clients[1]);
  });
});
