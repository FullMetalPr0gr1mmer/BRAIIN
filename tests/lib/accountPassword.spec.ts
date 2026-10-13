import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext, Role } from '@/lib/auth/types';
import { PASSWORD_MIN } from '@schemas/adminPrefs';

// Changing your own password through the admin (Admin v2 F8, CLAUDE.md §3 Pillar 1, AV-05
// tests): the current password re-authenticates first and a wrong one counts toward the
// sign-in lockout (5 in 15 minutes), so an unattended session cannot change it through
// this route; only a refused password counts, never an auth server that could not check
// it; a locked account is refused before anything is tried, and an unreachable lockout
// store fails closed; the new password is set and every OTHER session is signed out; a
// refused current password and the change are audited, and no password reaches an audit
// row, a log line or a response. Supabase Auth's own endpoint is outside this route: the
// local stack's half of what closes it is pinned at the end (supabase/config.toml), the
// hosted half is owner item O-24 (docs/admin-v2/deviations.md), and the last block holds
// every record of that residual to what the auth server itself does.
//
// The lockout's counting is SQL (0009), stubbed here with its contract, as in
// tests/authz/login.spec.ts.

const state = vi.hoisted(() => ({
  threshold: 5,
  failures: new Map<string, number>(),
  rpcs: [] as string[],
  storeUp: true,
  audits: [] as { action: string; entityId?: string; detail?: Record<string, unknown> }[],
  logs: [] as Record<string, unknown>[],
}));

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
vi.mock('@/lib/admin/audit', () => ({
  writeAudit: async (_sb: unknown, _ctx: unknown, entry: (typeof state.audits)[number]) => {
    state.audits.push(entry);
    return true;
  },
}));
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: Record<string, unknown>) => {
    state.logs.push(entry);
    return true;
  },
}));

const { changeMyPassword } = await import('@/lib/admin/account');
const { POST } = (await import('@/pages/api/admin/me/password')) as { POST: APIRoute };
const { LOCKOUT_DURATION_MINUTES } = await import('@/lib/auth/lockout');

const EMAIL = 'person@example.test';
const CURRENT = 'the-current-password-1';
const NEXT = 'a-brand-new-password-22';

const session = (role: Role = 'seo', isActive = true): AuthContext => ({
  userId: 'u-1',
  tenantId: 't-1',
  role,
  isActive,
  email: EMAIL,
});

interface AuthError {
  code?: string;
  status?: number;
  message: string;
}

interface AuthOptions {
  /** What signInWithPassword answers whatever the password: the auth server failing. */
  signInError?: AuthError;
  /** The error updateUser answers with, or none. */
  updateError?: AuthError;
  /** signOut({ scope: 'others' }) fails. */
  othersFail?: boolean;
}

/** GoTrue's answer to a wrong password. */
const WRONG_PASSWORD: AuthError = {
  code: 'invalid_credentials',
  status: 400,
  message: 'Invalid login credentials',
};

/** The session client's auth half: the current password is CURRENT. */
function fakeClient(options: AuthOptions = {}) {
  const calls: string[] = [];
  const signIns: { email: string; password: string }[] = [];
  const updates: unknown[] = [];
  const sb = {
    auth: {
      signInWithPassword: async (credentials: { email: string; password: string }) => {
        calls.push('signIn');
        signIns.push(credentials);
        if (options.signInError) {
          return { data: { user: null, session: null }, error: options.signInError };
        }
        return credentials.password === CURRENT
          ? { data: { user: {}, session: {} }, error: null }
          : { data: { user: null, session: null }, error: WRONG_PASSWORD };
      },
      updateUser: async (attributes: unknown) => {
        calls.push('update');
        updates.push(attributes);
        return options.updateError
          ? { data: { user: null }, error: options.updateError }
          : { data: { user: {} }, error: null };
      },
      signOut: async (opts?: { scope?: string }) => {
        calls.push(`signOut:${opts?.scope ?? 'global'}`);
        return { error: options.othersFail ? { message: 'down' } : null };
      },
    },
  };
  return { sb: sb as unknown as SupabaseClient, calls, signIns, updates };
}

beforeEach(() => {
  state.failures.clear();
  state.rpcs.length = 0;
  state.storeUp = true;
  state.audits.length = 0;
  state.logs.length = 0;
});

/** Nothing the person typed as a password is in any audit row or log line. */
function expectNoPasswordRecorded() {
  const recorded = JSON.stringify([state.audits, state.logs]);
  for (const secret of [CURRENT, NEXT, 'wrong-password-99']) {
    expect(recorded).not.toContain(secret);
  }
}

describe('changeMyPassword', () => {
  it('re-authenticates as the session, sets the new password, then signs out the other sessions', async () => {
    const { sb, calls, signIns, updates } = fakeClient();
    const outcome = await changeMyPassword(sb, session(), { current: CURRENT, next: NEXT }, null);
    expect(outcome).toEqual({ ok: true, othersSignedOut: true });
    expect(calls).toEqual(['signIn', 'update', 'signOut:others']);
    expect(signIns).toEqual([{ email: EMAIL, password: CURRENT }]);
    // The current password goes with the update too, so the route keeps working once the
    // auth server requires it (O-24).
    expect(updates).toEqual([{ password: NEXT, current_password: CURRENT }]);
    expect(state.rpcs).toEqual(['login_is_locked']);
    expect(state.audits).toEqual([
      {
        action: 'auth.password_change',
        entityType: 'profile',
        entityId: 'u-1',
        detail: { otherSessionsEnded: true },
      },
    ]);
    expectNoPasswordRecorded();
  });

  it('a wrong current password counts toward the lockout, changes nothing and is audited', async () => {
    const { sb, calls } = fakeClient();
    const outcome = await changeMyPassword(
      sb,
      session(),
      { current: 'wrong-password-99', next: NEXT },
      '203.0.113.7',
    );
    expect(outcome).toEqual({ ok: false, reason: 'wrong-current' });
    expect(calls).toEqual(['signIn']);
    expect(state.rpcs).toEqual(['login_is_locked', 'register_failed_login']);
    expect(state.failures.get(EMAIL)).toBe(1);
    expect(state.audits).toEqual([
      {
        action: 'auth.password_change_refused',
        entityType: 'profile',
        entityId: 'u-1',
        detail: { reason: 'wrong-current' },
      },
    ]);
    expectNoPasswordRecorded();
  });

  it('the fifth wrong try locks the account, and the next is refused before it is tried', async () => {
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { sb } = fakeClient();
      const outcome = await changeMyPassword(
        sb,
        session(),
        { current: 'wrong-password-99', next: NEXT },
        null,
      );
      outcomes.push(outcome.ok ? 'ok' : outcome.reason);
    }
    expect(outcomes).toEqual([
      'wrong-current',
      'wrong-current',
      'wrong-current',
      'wrong-current',
      'locked',
    ]);

    // Even the right password is not tried now: the lockout is checked first.
    const { sb, calls } = fakeClient();
    const outcome = await changeMyPassword(sb, session(), { current: CURRENT, next: NEXT }, null);
    expect(outcome).toEqual({ ok: false, reason: 'locked' });
    expect(calls).toEqual([]);
    expect(state.audits.at(-1)).toMatchObject({
      action: 'auth.password_change_refused',
      detail: { reason: 'locked' },
    });
  });

  it('shares its count with the sign-in form: failures there count here', async () => {
    state.failures.set(EMAIL, 4);
    const { sb } = fakeClient();
    const outcome = await changeMyPassword(
      sb,
      session(),
      { current: 'wrong-password-99', next: NEXT },
      null,
    );
    expect(outcome).toEqual({ ok: false, reason: 'locked' });
  });

  it('only a refused password counts: a rate limit, an outage or a captcha refusal counts nothing', async () => {
    const failures: AuthError[] = [
      { code: 'over_request_rate_limit', status: 429, message: 'rate limited' },
      { status: 503, message: 'upstream' },
      { status: 0, message: 'fetch failed' },
      { code: 'captcha_failed', status: 400, message: 'captcha required' },
    ];
    for (const signInError of failures) {
      const { sb, calls } = fakeClient({ signInError });
      // The right password: the person did nothing wrong, the server could not check it.
      const outcome = await changeMyPassword(sb, session(), { current: CURRENT, next: NEXT }, null);
      const label = JSON.stringify(signInError);
      expect(outcome, label).toEqual({ ok: false, reason: 'failed' });
      expect(calls, label).toEqual(['signIn']);
    }
    expect(state.rpcs).not.toContain('register_failed_login');
    expect(state.failures.get(EMAIL)).toBeUndefined();
    expect(state.audits).toEqual([]);
    expect(state.logs.map((log) => log['detail'])).toEqual([
      { status: 429, code: 'over_request_rate_limit' },
      { status: 503, code: null },
      { status: 0, code: null },
      { status: 400, code: 'captcha_failed' },
    ]);
    expectNoPasswordRecorded();
  });

  it('a wrong password from an auth server without error codes (a bare 400) still counts', async () => {
    const legacy = { status: 400, message: 'Invalid login credentials' };
    const { sb } = fakeClient({ signInError: legacy });
    const outcome = await changeMyPassword(
      sb,
      session(),
      { current: 'wrong-password-99', next: NEXT },
      null,
    );
    expect(outcome).toEqual({ ok: false, reason: 'wrong-current' });
    expect(state.failures.get(EMAIL)).toBe(1);
  });

  it('fails closed: an unreachable lockout store refuses before the password is tried', async () => {
    state.storeUp = false;
    const { sb, calls } = fakeClient();
    const outcome = await changeMyPassword(sb, session(), { current: CURRENT, next: NEXT }, null);
    expect(outcome).toEqual({ ok: false, reason: 'locked' });
    expect(calls).toEqual([]);
  });

  it("the auth server's own refusals are named, and no other session is signed out", async () => {
    for (const [code, reason] of [
      ['weak_password', 'weak'],
      ['same_password', 'same'],
    ] as const) {
      const { sb, calls } = fakeClient({ updateError: { code, status: 422, message: code } });
      const outcome = await changeMyPassword(sb, session(), { current: CURRENT, next: NEXT }, null);
      expect(outcome, code).toEqual({ ok: false, reason });
      expect(calls, code).toEqual(['signIn', 'update']);
    }
    expect(state.audits.map((a) => a.action)).not.toContain('auth.password_change');
  });

  it("the auth server's own current-password check (O-24) counts a refusal as a wrong try", async () => {
    const { sb, calls } = fakeClient({
      updateError: {
        code: 'current_password_invalid',
        status: 400,
        message: 'Current password required when setting new password.',
      },
    });
    const outcome = await changeMyPassword(sb, session(), { current: CURRENT, next: NEXT }, null);
    expect(outcome).toEqual({ ok: false, reason: 'wrong-current' });
    expect(calls).toEqual(['signIn', 'update']);
    expect(state.failures.get(EMAIL)).toBe(1);
    expect(state.audits).toEqual([
      expect.objectContaining({
        action: 'auth.password_change_refused',
        detail: { reason: 'wrong-current' },
      }),
    ]);

    // Asked for a current password it was not sent: a fault of ours, never the person's.
    const missing = fakeClient({
      updateError: { code: 'current_password_required', status: 400, message: 'required' },
    });
    expect(
      await changeMyPassword(missing.sb, session(), { current: CURRENT, next: NEXT }, null),
    ).toEqual({ ok: false, reason: 'failed' });
    expect(state.failures.get(EMAIL)).toBe(1);
    expectNoPasswordRecorded();
  });

  it('an auth server failure is logged without the password, and nothing is signed out', async () => {
    const { sb, calls } = fakeClient({ updateError: { status: 500, message: 'upstream' } });
    const outcome = await changeMyPassword(sb, session(), { current: CURRENT, next: NEXT }, null);
    expect(outcome).toEqual({ ok: false, reason: 'failed' });
    expect(calls).toEqual(['signIn', 'update']);
    expect(state.logs).toEqual([
      expect.objectContaining({
        level: 'error',
        source: 'admin:account',
        detail: { status: 500, code: null },
      }),
    ]);
    expectNoPasswordRecorded();
  });

  it('says so when the other sessions could not be signed out', async () => {
    const { sb } = fakeClient({ othersFail: true });
    const outcome = await changeMyPassword(sb, session(), { current: CURRENT, next: NEXT }, null);
    expect(outcome).toEqual({ ok: true, othersSignedOut: false });
    expect(state.audits.at(-1)).toMatchObject({ detail: { otherSessionsEnded: false } });
  });
});

describe('POST /api/admin/me/password', () => {
  async function post(body: unknown, sb: SupabaseClient, auth: AuthContext | null = session()) {
    const request = new Request('https://admin.example.test/api/admin/me/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const res = await POST({
      locals: { session: auth, supabase: sb },
      request,
      url: new URL(request.url),
      params: {},
    } as unknown as Parameters<APIRoute>[0]);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  const valid = { current: CURRENT, next: NEXT, confirm: NEXT };

  it('every role may change its own password', async () => {
    for (const role of ['admin', 'content_creator', 'seo', 'developer'] as const) {
      const { status, body } = await post(valid, fakeClient().sb, session(role));
      expect(status, role).toBe(200);
      expect(body, role).toEqual({ ok: true, data: { changed: true, othersSignedOut: true } });
    }
  });

  it('a deactivated session is refused before anything is tried', async () => {
    const { sb, calls } = fakeClient();
    const { status } = await post(valid, sb, session('admin', false));
    expect(status).toBe(403);
    expect(calls).toEqual([]);
    expect(state.rpcs).toEqual([]);
  });

  it('a mismatched confirmation or a short password is refused before re-authenticating', async () => {
    for (const body of [
      { ...valid, confirm: 'something-else-entirely' },
      { current: CURRENT, next: 'short', confirm: 'short' },
      { current: CURRENT, next: CURRENT, confirm: CURRENT },
      { ...valid, extra: 'not allowed' },
    ]) {
      const { sb, calls } = fakeClient();
      const res = await post(body, sb);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(calls).toEqual([]);
    }
    expect(state.rpcs).toEqual([]);
  });

  it('a wrong current password is a 422 on that field; the fifth is the 423 the sign-in answers', async () => {
    const wrong = { current: 'wrong-password-99', next: NEXT, confirm: NEXT };
    const first = await post(wrong, fakeClient().sb);
    expect(first.status).toBe(422);
    expect(first.body).toMatchObject({ error: 'validation', field: 'current' });
    for (let i = 0; i < 3; i += 1) await post(wrong, fakeClient().sb);
    const fifth = await post(wrong, fakeClient().sb);
    expect(fifth.status).toBe(423);
    expect(fifth.body).toMatchObject({
      error: 'locked',
      retryAfterMinutes: LOCKOUT_DURATION_MINUTES,
    });
  });

  it('an auth server that cannot check the password answers 502, never "wrong password"', async () => {
    const unavailable = fakeClient({
      signInError: { code: 'over_request_rate_limit', status: 429, message: 'rate limited' },
    });
    const res = await post(valid, unavailable.sb);
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error: 'server' });
    expect(state.failures.get(EMAIL)).toBeUndefined();
  });

  it('never echoes a password', async () => {
    const responses = [
      await post(valid, fakeClient().sb),
      await post({ current: 'wrong-password-99', next: NEXT, confirm: NEXT }, fakeClient().sb),
      await post(valid, fakeClient({ updateError: { status: 500, message: 'x' } }).sb),
    ];
    const text = JSON.stringify(responses);
    for (const secret of [CURRENT, NEXT, 'wrong-password-99']) expect(text).not.toContain(secret);
    expect(responses[2]!.status).toBe(502);
  });
});

describe('the auth server holds the same line (supabase/config.toml, Admin v2 F8)', () => {
  // One TOML table's own lines, comments dropped: from its header to the next one.
  function tomlTable(name: string): string {
    const lines = readFileSync(join(process.cwd(), 'supabase/config.toml'), 'utf8').split(/\r?\n/);
    const start = lines.findIndex((line) => line.trim() === `[${name}]`);
    if (start < 0) return '';
    const next = lines.findIndex((line, i) => i > start && /^\s*\[/.test(line));
    return lines
      .slice(start + 1, next < 0 ? undefined : next)
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
  }

  it("refuses a new password shorter than the admin's at the auth server itself", () => {
    expect(tomlTable('auth')).toMatch(
      new RegExp(`^minimum_password_length *= *${PASSWORD_MIN} *$`, 'm'),
    );
  });

  it('asks a session older than a day for more than its token (Secure password change)', () => {
    // Never SMTP for the admin's route: it re-authenticates, so its session is minutes old.
    expect(tomlTable('auth.email')).toMatch(/^secure_password_change\s*=\s*true\s*$/m);
  });
});

describe('the O-24 residual is recorded as GoTrue behaves (Admin v2 F8, CLAUDE.md §11)', () => {
  // A direct `PUT /auth/v1/user` (supabase/auth internal/api/user.go, UserUpdate) calls
  // user.UpdatePassword, which signs out every other session of the user
  // (LogoutAllExceptMe), and writes `user_updated_password` to GoTrue's own audit log. The
  // gap is the app's hash-chained audit_log, not auditing as such, and a takeover signs the
  // owner's other devices out. Every place the residual is stated says exactly that, so the
  // remainder the owner is asked to accept (O-24) rests on what the auth server does.
  const read = (file: string): string => readFileSync(join(process.cwd(), file), 'utf8');
  // One passage, whitespace and a doc comment's leading `*` folded, so wrapping is moot.
  function passage(file: string, from: string, to: string): string {
    const text = read(file);
    const start = text.indexOf(from);
    if (start < 0) return '';
    const end = text.indexOf(to, start + from.length);
    return text
      .slice(start, end < 0 ? undefined : end)
      .replace(/\n\s*\*(?!\*)/g, '\n')
      .replace(/\s+/g, ' ');
  }
  const records: [string, string][] = [
    ['CLAUDE.md §3', passage('CLAUDE.md', '- [ ] Login lockout:', '\n')],
    ['README O-24', passage('docs/admin-v2/README.md', '- **O-24**', '\n')],
    [
      'deviations.md',
      passage(
        'docs/admin-v2/deviations.md',
        '- **A password changed at Supabase Auth itself**',
        '*Owner:* Kareem (O-24)',
      ),
    ],
    [
      'as-built F8',
      passage('docs/admin-v2/as-built/F8.md', '## Residual risk: a password changed', '\n## '),
    ],
    ['launch runbook §2a', passage('docs/launch-runbook.md', '### 2a.', '\n## ')],
    ['account.ts', passage('src/lib/admin/account.ts', 'WHAT THIS DOES NOT COVER', '*/')],
  ];

  it.each(records)('%s names what GoTrue itself does on a direct change', (_where, text) => {
    expect(text).not.toBe('');
    expect(text).toContain('user_updated_password');
    expect(text).toMatch(/hash-chained `(public\.)?audit_log`/);
    expect(text).toMatch(/GoTrue (then )?signs out every other session of that user/);
  });

  it.each(records)(
    '%s never says the direct change is unaudited or spares other sessions',
    (_where, text) => {
      expect(text).not.toMatch(
        /no audit row|unaudited|audits no direct call|no other session signed out/i,
      );
    },
  );
});
