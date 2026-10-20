import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AstroCookies } from 'astro';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import type { PendingSecondStep } from '@/lib/auth/twoStep';
import { TENANT, UUID } from './harness';

// /admin/2fa's guards (Admin v2 U17). The page is not an API route, so the endpoint matrix
// cannot drive it (tests/authz/endpointCoverage.spec.ts): its intents are driven here for every
// kind of caller, with the real lockout module over a stub of 0009's RPCs (as
// tests/authz/login.spec.ts does) and GoTrue's MFA API stubbed by its documented answers.
//   - who may post what: a pending challenge verifies (or signs out); a pending setup starts
//     and confirms; a full session without 2FA starts and confirms; one with 2FA turns it off.
//     Anything else is refused (403) before a field is read or GoTrue asked.
//   - the lockout: a wrong code at sign-in or to turn 2FA off counts as a wrong password; the
//     fifth ends the session; a locked account is refused before GoTrue is asked; a failure
//     at the auth server counts nothing; a wrong code while confirming a new setup is not
//     counted (decision D7).
//   - the sign-in finishes only after the code: registerSuccess and `auth.login` then, never
//     at the password (tests/authz/login.spec.ts holds that half).
//   - the setup key and the code are in no audit row, no system log, no redirect.

const EMAIL = 'staff@example.test';
const APP = '33333333-3333-4333-8333-333333333333';
const KEY = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

const state = vi.hoisted(() => ({
  threshold: 5,
  failures: new Map<string, number>(),
  rpcs: [] as string[],
  storeUp: true,
  /** What resolveAuthContext answers after a verified code. */
  after: null as unknown,
  logs: [] as unknown[],
  clearSessionCookies: vi.fn(),
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
      if (fn === 'register_successful_login') state.failures.delete(args.p_email);
      return { data: null, error: null };
    },
  }),
}));
vi.mock('@/lib/auth/context', () => ({
  resolveAuthContext: async () => ({ ctx: state.after, revoke: false, pending: null }),
}));
vi.mock('@/lib/auth/session', () => ({
  isSessionOnly: () => false,
  clearSessionCookies: state.clearSessionCookies,
}));
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: unknown) => {
    state.logs.push(entry);
    return true;
  },
}));

const { twoStepFormPost, viewFor, outcomeOf, otpauthUri, groupKey } =
  await import('@/lib/auth/twoStepFlow');
const { TotpCodeSchema, SetupKeySchema } = await import('@schemas/twoStep');

const MEMBER: AuthContext = {
  userId: UUID,
  tenantId: TENANT,
  role: 'seo',
  isActive: true,
  email: EMAIL,
  twoStep: { on: false, required: false, factorId: null },
};
const WITH_APP: AuthContext = { ...MEMBER, twoStep: { on: true, required: false, factorId: APP } };
const REQUIRED: AuthContext = { ...MEMBER, twoStep: { on: true, required: true, factorId: APP } };
const CHALLENGE: PendingSecondStep = {
  userId: UUID,
  tenantId: TENANT,
  email: EMAIL,
  role: 'seo',
  mode: 'challenge',
  factorId: APP,
};
const ENROL: PendingSecondStep = { ...CHALLENGE, mode: 'enrol', factorId: null };

type MfaAnswer = { data: unknown; error: unknown };

/** The request's session client: GoTrue's MFA API, audit inserts, sign-out. */
function sessionClient(
  answers: Partial<Record<'verify' | 'enroll' | 'unenroll' | 'list', MfaAnswer>> = {},
) {
  const audit: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const client = {
    auth: {
      signOut: vi.fn(async () => ({ error: null })),
      mfa: {
        challengeAndVerify: vi.fn(async () => {
          calls.push('verify');
          return answers.verify ?? { data: { access_token: 'x' }, error: null };
        }),
        enroll: vi.fn(async () => {
          calls.push('enroll');
          return (
            answers.enroll ?? {
              data: {
                id: APP,
                type: 'totp',
                totp: { secret: KEY, uri: 'otpauth://x', qr_code: 'data:x' },
              },
              error: null,
            }
          );
        }),
        unenroll: vi.fn(async () => {
          calls.push('unenroll');
          return answers.unenroll ?? { data: {}, error: null };
        }),
        listFactors: vi.fn(async () => {
          calls.push('list');
          return (
            answers.list ?? { data: { all: [], totp: [], phone: [], webauthn: [] }, error: null }
          );
        }),
      },
    },
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        audit.push({ table, ...row });
        return { error: null };
      },
    }),
  };
  return { client, audit, calls };
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function post(
  who: { session?: AuthContext | null; pending?: PendingSecondStep | null },
  fields: Record<string, string>,
  client = sessionClient().client,
) {
  return twoStepFormPost({
    sb: client as unknown as SupabaseClient,
    session: who.session ?? null,
    pending: who.pending ?? null,
    form: form(fields),
    cookies: {} as AstroCookies,
    ip: '203.0.113.9',
    brand: 'Studio',
  });
}

const WRONG = { data: null, error: { code: 'mfa_verification_failed', status: 422 } };
const OUTAGE = { data: null, error: { code: 'unexpected_failure', status: 500 } };

beforeEach(() => {
  state.failures.clear();
  state.rpcs.length = 0;
  state.storeUp = true;
  state.after = null;
  state.logs.length = 0;
  state.clearSessionCookies.mockClear();
});

describe('who may post what', () => {
  const ALL = ['verify', 'start', 'confirm', 'off', 'signout'] as const;
  const cases: [
    string,
    { session?: AuthContext; pending?: PendingSecondStep },
    readonly string[],
  ][] = [
    ['nobody (no session at all)', {}, []],
    ['a pending sign-in with an app', { pending: CHALLENGE }, ['verify', 'signout']],
    [
      'a pending sign-in whose team requires 2FA',
      { pending: ENROL },
      ['start', 'confirm', 'signout'],
    ],
    ['a member without 2FA', { session: MEMBER }, ['start', 'confirm', 'signout']],
    ['a member with 2FA', { session: WITH_APP }, ['off', 'signout']],
  ];

  it.each(cases)(
    '%s: anything else is refused before GoTrue is asked',
    async (_label, who, may) => {
      for (const intent of ALL) {
        if (may.includes(intent)) continue;
        const { client, calls } = sessionClient();
        const result = await post(who, { intent, code: '123456' }, client);
        expect(result, intent).toEqual({ kind: 'refuse', status: 403 });
        expect(calls, intent).toEqual([]);
      }
    },
  );

  it('an intent that is not one is refused', async () => {
    expect(await post({ session: MEMBER }, { intent: 'nope' })).toEqual({
      kind: 'refuse',
      status: 403,
    });
    expect(await post({ session: MEMBER }, {})).toEqual({ kind: 'refuse', status: 403 });
  });

  it('what the page shows each caller before a post', () => {
    expect(viewFor(null, null)).toBeNull();
    expect(viewFor(null, CHALLENGE)).toEqual({ mode: 'challenge' });
    expect(viewFor(null, ENROL)).toEqual({ mode: 'enrol' });
    expect(viewFor(MEMBER, null)).toEqual({ mode: 'intro' });
    expect(viewFor(WITH_APP, null)).toEqual({ mode: 'manage', required: false });
    expect(viewFor(REQUIRED, null)).toEqual({ mode: 'manage', required: true });
    // A context built by hand (no twoStep) reads as off.
    const { twoStep: _x, ...bare } = MEMBER;
    expect(viewFor(bare, null)).toEqual({ mode: 'intro' });
  });
});

describe('the code at sign-in (verify)', () => {
  it('a right code finishes the sign-in: only then the count is cleared and auth.login written', async () => {
    state.failures.set(EMAIL, 2);
    state.after = { ...WITH_APP, role: 'seo' };
    const { client, audit } = sessionClient();
    const result = await post(
      { pending: CHALLENGE },
      { intent: 'verify', code: '123 456', next: '/admin/leads' },
      client,
    );
    expect(result).toEqual({ kind: 'redirect', location: '/admin/leads' });
    expect(client.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({
      factorId: APP,
      code: '123456',
    });
    expect(state.rpcs).toEqual(['login_is_locked', 'register_successful_login']);
    expect(audit).toEqual([
      expect.objectContaining({
        table: 'audit_log',
        action: 'auth.login',
        actor_id: UUID,
        detail: { ip: '203.0.113.9', remember: true, second_step: 'totp' },
      }),
    ]);
  });

  it('Arabic-Indic digits from a keypad are the digits they are', async () => {
    state.after = WITH_APP;
    const { client } = sessionClient();
    await post({ pending: CHALLENGE }, { intent: 'verify', code: '١٢٣ ۴۵۶' }, client);
    expect(client.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({
      factorId: APP,
      code: '123456',
    });
  });

  it('a wrong code counts as a wrong password and says so; nothing is audited', async () => {
    const { client, audit } = sessionClient({ verify: WRONG });
    const result = await post({ pending: CHALLENGE }, { intent: 'verify', code: '000000' }, client);
    expect(result).toEqual({ kind: 'redirect', location: '/admin/2fa?error=bad-code' });
    expect(state.failures.get(EMAIL)).toBe(1);
    expect(audit).toEqual([]);
  });

  it('the fifth wrong code locks the account and ends the session', async () => {
    state.failures.set(EMAIL, 4);
    const { client } = sessionClient({ verify: WRONG });
    const result = await post({ pending: CHALLENGE }, { intent: 'verify', code: '000000' }, client);
    expect(result).toEqual({ kind: 'redirect', location: '/admin/login?error=locked' });
    expect(client.auth.signOut).toHaveBeenCalledOnce();
    expect(state.clearSessionCookies).toHaveBeenCalledOnce();
  });

  it('a locked account is refused before GoTrue is asked, and signed out', async () => {
    state.failures.set(EMAIL, 5);
    const { client, calls } = sessionClient();
    const result = await post({ pending: CHALLENGE }, { intent: 'verify', code: '123456' }, client);
    expect(result).toEqual({ kind: 'redirect', location: '/admin/login?error=locked' });
    expect(calls).toEqual([]);
    expect(client.auth.signOut).toHaveBeenCalledOnce();
  });

  it('fails closed: the lockout store unreachable reads as locked', async () => {
    state.storeUp = false;
    const { calls } = sessionClient();
    const result = await post({ pending: CHALLENGE }, { intent: 'verify', code: '123456' });
    expect(result).toEqual({ kind: 'redirect', location: '/admin/login?error=locked' });
    expect(calls).toEqual([]);
  });

  it('an outage or a rate limit at the auth server counts nothing and is logged without the code', async () => {
    for (const [answer, code] of [
      [OUTAGE, 'unavailable'],
      [{ data: null, error: { code: 'over_request_rate_limit', status: 429 } }, 'limited'],
    ] as const) {
      const { client } = sessionClient({ verify: answer });
      const result = await post(
        { pending: CHALLENGE },
        { intent: 'verify', code: '654321' },
        client,
      );
      expect(result).toEqual({ kind: 'redirect', location: `/admin/2fa?error=${code}` });
    }
    expect(state.failures.get(EMAIL)).toBeUndefined();
    expect(JSON.stringify(state.logs)).not.toContain('654321');
    expect(state.logs[0]).toEqual({
      level: 'error',
      source: 'auth:two-step',
      message: 'two-step verify failed at the auth server',
      detail: { status: 500, code: 'unexpected_failure' },
    });
  });

  it('something that cannot be a code is said, not counted, and never sent to GoTrue', async () => {
    for (const code of ['', '12345', '1234567', 'abcdef', '12 34 5x']) {
      const { client, calls } = sessionClient();
      const result = await post({ pending: CHALLENGE }, { intent: 'verify', code }, client);
      expect(result, code).toEqual({ kind: 'redirect', location: '/admin/2fa?error=bad-code' });
      expect(calls, code).toEqual([]);
    }
    expect(state.rpcs).toEqual([]);
  });

  it('a `next` outside the admin is held to /admin', async () => {
    state.after = WITH_APP;
    const result = await post(
      { pending: CHALLENGE },
      { intent: 'verify', code: '123456', next: 'https://evil.example/' },
    );
    expect(result).toEqual({ kind: 'redirect', location: '/admin' });
  });

  it('a code that verifies but leaves no context (the profile changed meanwhile) finishes nothing', async () => {
    state.after = null;
    const { client, audit } = sessionClient();
    const result = await post({ pending: CHALLENGE }, { intent: 'verify', code: '123456' }, client);
    expect(result).toEqual({ kind: 'redirect', location: '/admin/2fa?error=unavailable' });
    expect(state.rpcs).toEqual(['login_is_locked']);
    expect(audit).toEqual([]);
  });
});

describe('setting it up (start, confirm)', () => {
  it('start: abandoned setups go, a new app is enrolled, its key shown and never stored', async () => {
    const { client, calls } = sessionClient({
      list: {
        data: {
          all: [{ id: 'old-one', factor_type: 'totp', status: 'unverified' }],
          totp: [],
          phone: [],
          webauthn: [],
        },
        error: null,
      },
    });
    const result = await post({ session: MEMBER }, { intent: 'start' }, client);
    expect(calls).toEqual(['list', 'unenroll', 'enroll']);
    expect(client.auth.mfa.enroll).toHaveBeenCalledWith({
      factorType: 'totp',
      friendlyName: 'Authenticator app',
      issuer: 'Studio',
    });
    expect(result).toEqual({
      kind: 'render',
      status: 200,
      error: null,
      view: {
        mode: 'setup',
        factorId: APP,
        setupKey: KEY,
        otpauth: `otpauth://totp/Studio:staff%40example.test?secret=${KEY}&issuer=Studio`,
      },
    });
  });

  it('start with an app already verified: back to the page, nothing enrolled', async () => {
    const { client, calls } = sessionClient({
      list: { data: { all: [], totp: [{ id: APP }], phone: [], webauthn: [] }, error: null },
    });
    expect(await post({ session: MEMBER }, { intent: 'start' }, client)).toEqual({
      kind: 'redirect',
      location: '/admin/2fa',
    });
    expect(calls).toEqual(['list']);
  });

  it('start while the project has authenticator apps switched off: "Not set up", never an error', async () => {
    const { client } = sessionClient({
      enroll: { data: null, error: { code: 'mfa_totp_enroll_not_enabled', status: 422 } },
    });
    expect(await post({ pending: ENROL }, { intent: 'start' }, client)).toEqual({
      kind: 'render',
      status: 200,
      error: null,
      view: { mode: 'not-set-up' },
    });
  });

  it('confirm: a right code turns it on, audited; a member goes back to the page', async () => {
    state.after = WITH_APP;
    const { client, audit } = sessionClient();
    const result = await post(
      { session: MEMBER },
      { intent: 'confirm', factorId: APP, setupKey: KEY, code: '123456' },
      client,
    );
    expect(result).toEqual({ kind: 'redirect', location: '/admin/2fa?done=on' });
    expect(audit.map((row) => row['action'])).toEqual(['auth.two_step_on']);
    expect(state.rpcs).toEqual([]);
    expect(JSON.stringify(audit)).not.toContain(KEY);
  });

  it('confirm in a forced setup also finishes the sign-in', async () => {
    state.after = WITH_APP;
    state.failures.set(EMAIL, 1);
    const { client, audit } = sessionClient();
    const result = await post(
      { pending: ENROL },
      { intent: 'confirm', factorId: APP, setupKey: KEY, code: '123456', next: '/admin/blog' },
      client,
    );
    expect(result).toEqual({ kind: 'redirect', location: '/admin/blog' });
    expect(audit.map((row) => row['action'])).toEqual(['auth.two_step_on', 'auth.login']);
    expect(state.rpcs).toEqual(['register_successful_login']);
  });

  it('confirm with a wrong code: the same step again, the key kept, not counted (D7)', async () => {
    const { client } = sessionClient({ verify: WRONG });
    const result = await post(
      { session: MEMBER },
      { intent: 'confirm', factorId: APP, setupKey: KEY.toLowerCase(), code: '000000' },
      client,
    );
    expect(result).toMatchObject({
      kind: 'render',
      status: 422,
      error: 'bad-code',
      view: { mode: 'setup', factorId: APP, setupKey: KEY },
    });
    expect(state.rpcs).toEqual([]);
  });

  it('confirm with a tampered or missing setup: start again, GoTrue not asked', async () => {
    for (const fields of [
      { factorId: 'not-a-uuid', setupKey: KEY },
      { factorId: APP, setupKey: 'not base32!' },
      { factorId: APP },
    ]) {
      const { client, calls } = sessionClient();
      const result = await post(
        { session: MEMBER },
        { intent: 'confirm', code: '123456', ...fields },
        client,
      );
      expect(result).toEqual({ kind: 'redirect', location: '/admin/2fa?error=gone' });
      expect(calls).toEqual([]);
    }
  });

  it('confirm on a setup GoTrue no longer has: start again', async () => {
    const { client } = sessionClient({
      verify: { data: null, error: { code: 'mfa_factor_not_found', status: 404 } },
    });
    const result = await post(
      { session: MEMBER },
      { intent: 'confirm', factorId: APP, setupKey: KEY, code: '123456' },
      client,
    );
    expect(result).toEqual({ kind: 'redirect', location: '/admin/2fa?error=gone' });
  });
});

describe('turning it off', () => {
  it('needs a current code; then the app is removed and the change audited', async () => {
    const { client, audit, calls } = sessionClient();
    const result = await post({ session: WITH_APP }, { intent: 'off', code: '123456' }, client);
    expect(result).toEqual({ kind: 'redirect', location: '/admin/2fa?done=off' });
    expect(calls).toEqual(['verify', 'unenroll']);
    expect(client.auth.mfa.unenroll).toHaveBeenCalledWith({ factorId: APP });
    expect(audit.map((row) => row['action'])).toEqual(['auth.two_step_off']);
  });

  it('is refused while the team requires 2FA, before anything is asked', async () => {
    const { client, calls } = sessionClient();
    expect(await post({ session: REQUIRED }, { intent: 'off', code: '123456' }, client)).toEqual({
      kind: 'redirect',
      location: '/admin/2fa?error=required',
    });
    expect(calls).toEqual([]);
  });

  it('a wrong code counts toward the lockout; the fifth signs the session out', async () => {
    state.failures.set(EMAIL, 3);
    const first = sessionClient({ verify: WRONG });
    expect(
      await post({ session: WITH_APP }, { intent: 'off', code: '000000' }, first.client),
    ).toEqual({
      kind: 'redirect',
      location: '/admin/2fa?error=bad-code',
    });
    const fifth = sessionClient({ verify: WRONG });
    expect(
      await post({ session: WITH_APP }, { intent: 'off', code: '000000' }, fifth.client),
    ).toEqual({
      kind: 'redirect',
      location: '/admin/login?error=locked',
    });
    expect(fifth.calls).toEqual(['verify']);
    // The sign-out of a full session is audited (auth.logout), the app is not removed.
    expect(fifth.audit.map((row) => row['action'])).toEqual(['auth.logout']);
  });
});

describe('signing out from the page', () => {
  it('a pending sign-in signs out with no audit row (it never had a context)', async () => {
    const { client, audit } = sessionClient();
    expect(await post({ pending: CHALLENGE }, { intent: 'signout' }, client)).toEqual({
      kind: 'redirect',
      location: '/admin/login',
    });
    expect(client.auth.signOut).toHaveBeenCalledOnce();
    expect(audit).toEqual([]);
  });
});

describe('the helpers', () => {
  it('reads GoTrue’s MFA errors: only a refused code is the person’s', () => {
    expect(outcomeOf({ code: 'mfa_verification_failed' })).toBe('wrong');
    expect(outcomeOf({ status: 422 })).toBe('wrong');
    expect(outcomeOf({ status: 400 })).toBe('wrong');
    expect(outcomeOf({ code: 'mfa_factor_not_found' })).toBe('gone');
    expect(outcomeOf({ code: 'mfa_totp_verify_not_enabled' })).toBe('not-set-up');
    expect(outcomeOf({ code: 'over_request_rate_limit' })).toBe('limited');
    expect(outcomeOf({ status: 429 })).toBe('limited');
    expect(outcomeOf({ code: 'mfa_challenge_expired', status: 422 })).toBe('unavailable');
    expect(outcomeOf({ status: 0 })).toBe('unavailable');
  });

  it('the code schema: six digits, spaces dropped, Arabic-Indic digits read', () => {
    expect(TotpCodeSchema.parse(' 123 456 ')).toBe('123456');
    expect(TotpCodeSchema.parse('٠١٢٣٤٥')).toBe('012345');
    expect(TotpCodeSchema.parse('۰۱۲۳۴۵')).toBe('012345');
    for (const bad of ['12345', '1234567', '12a456', '', 'x'.repeat(40)]) {
      expect(TotpCodeSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('the setup key: base32, spaces dropped, upper case', () => {
    expect(SetupKeySchema.parse('jbsw y3dp ehpk 3pxp')).toBe('JBSWY3DPEHPK3PXP');
    for (const bad of ['short', 'JBSWY3DPEHPK3PX1', `${KEY}<`]) {
      expect(SetupKeySchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('the key in groups of four, and the link an app on this device opens', () => {
    expect(groupKey('ABCDEFGHIJ')).toBe('ABCD EFGH IJ');
    expect(otpauthUri(KEY, 'A & B', 'a+b@example.test')).toBe(
      `otpauth://totp/A%20%26%20B:a%2Bb%40example.test?secret=${KEY}&issuer=A+%26+B`,
    );
  });
});
