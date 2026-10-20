import type { AstroCookies } from 'astro';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from './types';
import type { PendingSecondStep } from './twoStep';
import { TWO_STEP_PATH } from './twoStep';
import { resolveAuthContext } from './context';
import { isLockedOut, registerFailure, registerSuccess } from './lockout';
import { isSessionOnly } from './session';
import { safeNext } from './next';
import { writeAudit } from '@/lib/admin/audit';
import { endSession } from '@/lib/admin/account';
import { writeSystemLog } from '@/lib/data/systemLog';
import {
  FactorIdSchema,
  SetupKeySchema,
  TotpCodeSchema,
  TwoStepIntentSchema,
  type TwoStepIntent,
} from '@schemas/twoStep';

// Every second-step operation of /admin/2fa (Admin v2 U17), on the request's own session
// client (`locals.supabase`), so GoTrue sees the person's own session and the new aal2 session
// a verified code returns is written into the `__Host-` cookie by that client. The page is zero
// JS: it posts to itself, and this module decides what a post does (tests/authz/twoStep.spec.ts
// drives every intent for every kind of caller).
//
//   verify   a pending session's code. Locked first (refused before GoTrue is asked); a wrong
//            code counts toward the sign-in lockout (5 in 15 minutes, as a wrong password) and
//            the fifth ends the session; only a right one finishes the sign-in: the lockout
//            count is cleared (registerSuccess) and `auth.login` is audited, never before.
//   start    the setup step: abandoned setups are removed, a new authenticator app is enrolled,
//            and its key is shown. Rendered, never redirected: the secret is never stored here.
//   confirm  the first code from the new app. A wrong one is NOT counted (the person is already
//            signed in, or is setting up because their team requires it; GoTrue's own rate limit
//            applies). Right: `auth.two_step_on`, and for a forced setup the sign-in finishes.
//   off      turning your own 2FA off: never while the tenant requires it, and only with a
//            current code (counted, as at sign-in); `auth.two_step_off`.
//   signout  as the account page's.
//
// Never logged or audited: the setup key, a code. A failure at the auth server is logged with
// its status and GoTrue's error code only.

/** What the page shows. */
export type TwoStepView =
  /** A pending session with an authenticator app: type the code. */
  | { mode: 'challenge' }
  /** A pending session whose tenant requires 2FA and who has none: set it up first. */
  | { mode: 'enrol' }
  /** A full session without 2FA: what it is, and "Set up". */
  | { mode: 'intro' }
  /** The setup step: the key (and the link an authenticator on this device opens), then a code. */
  | { mode: 'setup'; factorId: string; setupKey: string; otpauth: string }
  /** A full session with 2FA on. */
  | { mode: 'manage'; required: boolean }
  /** Supabase Auth's authenticator apps are switched off for this project (owner item O-25). */
  | { mode: 'not-set-up' };

/** The codes the page reads from `?error=` and `?done=` (src/lib/auth/messages.ts). */
export type TwoStepCode =
  'bad-code' | 'unavailable' | 'limited' | 'gone' | 'required' | 'expired-form' | 'too-large';

export type TwoStepResult =
  | { kind: 'redirect'; location: string }
  | { kind: 'render'; status: number; view: TwoStepView; error: TwoStepCode | null }
  /** The intent is not this caller's (a pending session turning 2FA off, and so on). */
  | { kind: 'refuse'; status: 403 };

/** The friendly name GoTrue keeps for the app; one per person. */
export const FACTOR_NAME = 'Authenticator app';

/** Where a refused or failed post goes: the page, with a code and the person's `next`. */
function back(code: TwoStepCode | null, next: string, done?: 'on' | 'off'): string {
  const params = new URLSearchParams();
  if (code) params.set('error', code);
  if (done) params.set('done', done);
  if (next !== '/admin') params.set('next', next);
  const query = params.toString();
  return query ? `${TWO_STEP_PATH}?${query}` : TWO_STEP_PATH;
}

const LOCKED_SIGN_IN = '/admin/login?error=locked';

/** What the page shows a caller before any post. */
export function viewFor(
  session: AuthContext | null,
  pending: PendingSecondStep | null,
): TwoStepView | null {
  if (pending) return { mode: pending.mode };
  if (!session) return null;
  return session.twoStep?.on
    ? { mode: 'manage', required: session.twoStep.required }
    : { mode: 'intro' };
}

// ── GoTrue's answers ─────────────────────────────────────────────────────────────

interface AuthErrorLike {
  code?: unknown;
  status?: unknown;
}

type Outcome = 'wrong' | 'gone' | 'not-set-up' | 'limited' | 'unavailable';

/**
 * One table for what GoTrue's MFA errors mean here (auth-js 2.110.7's ErrorCode union). Only
 * `mfa_verification_failed` (or a 400/422 with no code, from an auth server that predates
 * codes) is the person's wrong code; everything else is a failure to check, which counts
 * nothing toward the lockout.
 */
export function outcomeOf(error: AuthErrorLike): Outcome {
  switch (error.code) {
    case 'mfa_verification_failed':
      return 'wrong';
    case 'mfa_factor_not_found':
      return 'gone';
    case 'mfa_totp_enroll_not_enabled':
    case 'mfa_totp_verify_not_enabled':
      return 'not-set-up';
    case 'over_request_rate_limit':
      return 'limited';
    default:
      if (error.code == null && (error.status === 400 || error.status === 422)) return 'wrong';
      if (error.status === 429) return 'limited';
      return 'unavailable';
  }
}

function logFailure(step: string, error: AuthErrorLike): void {
  void writeSystemLog({
    level: 'error',
    source: 'auth:two-step',
    message: `two-step ${step} failed at the auth server`,
    detail: {
      status: typeof error.status === 'number' ? error.status : null,
      code: typeof error.code === 'string' ? error.code : null,
    },
  });
}

/** A failure that is not the person's: logged, and said as "try again" or "wait". */
function failure(step: string, error: AuthErrorLike): 'limited' | 'unavailable' {
  logFailure(step, error);
  return outcomeOf(error) === 'limited' ? 'limited' : 'unavailable';
}

/** The setup key as people read it: groups of four. */
export function groupKey(key: string): string {
  return key.replace(/(.{4})(?=.)/g, '$1 ');
}

/**
 * The link an authenticator app on this device opens (RFC 6238's defaults GoTrue uses: SHA-1,
 * 6 digits, 30 seconds). Built here from the key, the brand and the address, so a re-rendered
 * setup step needs nothing but the key.
 */
export function otpauthUri(key: string, issuer: string, account: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({ secret: key, issuer });
  return `otpauth://totp/${label}?${params}`;
}

// ── The operations ────────────────────────────────────────────────────────────────

/** Ends the session at the auth server and in the browser (the fifth wrong code, sign-out). */
async function signOutAll(
  sb: SupabaseClient,
  session: AuthContext | null,
  cookies: AstroCookies,
): Promise<void> {
  await endSession(sb, session, cookies);
}

/** The setup step for the caller, or why there is none. */
export async function startEnrolment(
  sb: SupabaseClient,
  email: string,
  brand: string,
): Promise<TwoStepView | 'already-on' | 'limited' | 'unavailable'> {
  const { data: list, error: listError } = await sb.auth.mfa.listFactors();
  if (listError || !list) return failure('list', listError ?? {});
  if (list.totp.length > 0) return 'already-on';
  // An abandoned setup (a key shown, never confirmed) holds the app's name: remove it first.
  for (const factor of list.all) {
    if (factor.factor_type === 'totp' && factor.status !== 'verified') {
      const { error } = await sb.auth.mfa.unenroll({ factorId: factor.id });
      if (error) return failure('cleanup', error);
    }
  }
  const { data, error } = await sb.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: FACTOR_NAME,
    issuer: brand,
  });
  if (error || !data || data.type !== 'totp') {
    if (error && outcomeOf(error) === 'not-set-up') return { mode: 'not-set-up' };
    return failure('enrol', error ?? {});
  }
  const setupKey = data.totp.secret;
  return {
    mode: 'setup',
    factorId: data.id,
    setupKey,
    otpauth: otpauthUri(setupKey, brand, email),
  };
}

export interface TwoStepPost {
  sb: SupabaseClient;
  session: AuthContext | null;
  pending: PendingSecondStep | null;
  form: FormData;
  cookies: AstroCookies;
  ip: string | null;
  /** The brand (site_profile), the app's label for this account. Never spelled in code. */
  brand: string;
}

/** The intents each kind of caller may post; anything else is refused (403). */
function allowed(session: AuthContext | null, pending: PendingSecondStep | null): TwoStepIntent[] {
  if (pending?.mode === 'challenge') return ['verify', 'signout'];
  if (pending?.mode === 'enrol') return ['start', 'confirm', 'signout'];
  if (!session) return [];
  return session.twoStep?.on ? ['off', 'signout'] : ['start', 'confirm', 'signout'];
}

const field = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

/**
 * The finished sign-in after a code (a challenge, or a forced setup): the session is now aal2,
 * so it is resolved again for its context; the lockout count is cleared and `auth.login`
 * audited only now.
 */
async function finishSignIn(
  input: TwoStepPost,
  email: string,
  next: string,
): Promise<TwoStepResult> {
  const { ctx } = await resolveAuthContext(input.sb);
  if (!ctx) return { kind: 'redirect', location: back('unavailable', next) };
  await registerSuccess(email, input.ip);
  await writeAudit(input.sb, ctx, {
    action: 'auth.login',
    entityType: 'profile',
    entityId: ctx.userId,
    detail: { ip: input.ip ?? null, remember: !isSessionOnly(input.cookies), second_step: 'totp' },
  });
  return { kind: 'redirect', location: next };
}

/** A wrong code that counts: the fifth ends the session and goes to sign-in, locked. */
async function countWrongCode(
  input: TwoStepPost,
  email: string,
  next: string,
): Promise<TwoStepResult> {
  const nowLocked = await registerFailure(email, input.ip);
  if (nowLocked) {
    await signOutAll(input.sb, input.session, input.cookies);
    return { kind: 'redirect', location: LOCKED_SIGN_IN };
  }
  return { kind: 'redirect', location: back('bad-code', next) };
}

async function verify(input: TwoStepPost, pending: PendingSecondStep, next: string) {
  const code = TotpCodeSchema.safeParse(field(input.form, 'code'));
  // A code that cannot be one is no guess: said, not counted.
  if (!code.success) return { kind: 'redirect', location: back('bad-code', next) } as const;
  if (await isLockedOut(pending.email)) {
    await signOutAll(input.sb, null, input.cookies);
    return { kind: 'redirect', location: LOCKED_SIGN_IN } as const;
  }
  if (!pending.factorId) return { kind: 'redirect', location: back('unavailable', next) } as const;
  const { error } = await input.sb.auth.mfa.challengeAndVerify({
    factorId: pending.factorId,
    code: code.data,
  });
  if (error) {
    if (outcomeOf(error) === 'wrong') return countWrongCode(input, pending.email, next);
    return { kind: 'redirect', location: back(failure('verify', error), next) } as const;
  }
  return finishSignIn(input, pending.email, next);
}

async function confirm(input: TwoStepPost, next: string): Promise<TwoStepResult> {
  const factorId = FactorIdSchema.safeParse(field(input.form, 'factorId'));
  const setupKey = SetupKeySchema.safeParse(field(input.form, 'setupKey'));
  if (!factorId.success || !setupKey.success) {
    return { kind: 'redirect', location: back('gone', next) };
  }
  const email = input.pending?.email ?? input.session?.email ?? '';
  const setup: TwoStepView = {
    mode: 'setup',
    factorId: factorId.data,
    setupKey: setupKey.data,
    otpauth: otpauthUri(setupKey.data, input.brand, email),
  };
  const again = (error: TwoStepCode): TwoStepResult => ({
    kind: 'render',
    status: 422,
    view: setup,
    error,
  });
  const code = TotpCodeSchema.safeParse(field(input.form, 'code'));
  if (!code.success) return again('bad-code');
  const { error } = await input.sb.auth.mfa.challengeAndVerify({
    factorId: factorId.data,
    code: code.data,
  });
  if (error) {
    const outcome = outcomeOf(error);
    // Not counted toward the lockout (decision D7): the same step again.
    if (outcome === 'wrong') return again('bad-code');
    if (outcome === 'gone') return { kind: 'redirect', location: back('gone', next) };
    if (outcome === 'not-set-up')
      return { kind: 'render', status: 200, view: { mode: 'not-set-up' }, error: null };
    return again(failure('confirm', error));
  }
  const { ctx } = await resolveAuthContext(input.sb);
  if (!ctx) return { kind: 'redirect', location: back('unavailable', next) };
  await writeAudit(input.sb, ctx, {
    action: 'auth.two_step_on',
    entityType: 'profile',
    entityId: ctx.userId,
  });
  if (input.pending) {
    // A forced setup was the second step of a sign-in: it is finished now.
    await registerSuccess(input.pending.email, input.ip);
    await writeAudit(input.sb, ctx, {
      action: 'auth.login',
      entityType: 'profile',
      entityId: ctx.userId,
      detail: {
        ip: input.ip ?? null,
        remember: !isSessionOnly(input.cookies),
        second_step: 'totp',
      },
    });
    return { kind: 'redirect', location: next };
  }
  return { kind: 'redirect', location: back(null, next, 'on') };
}

async function turnOff(input: TwoStepPost, session: AuthContext, next: string) {
  if (session.twoStep?.required) {
    return { kind: 'redirect', location: back('required', next) } as const;
  }
  const factorId = session.twoStep?.factorId ?? null;
  const code = TotpCodeSchema.safeParse(field(input.form, 'code'));
  if (!code.success) return { kind: 'redirect', location: back('bad-code', next) } as const;
  if (await isLockedOut(session.email)) {
    await signOutAll(input.sb, session, input.cookies);
    return { kind: 'redirect', location: LOCKED_SIGN_IN } as const;
  }
  if (!factorId) return { kind: 'redirect', location: back('unavailable', next) } as const;
  const { error } = await input.sb.auth.mfa.challengeAndVerify({ factorId, code: code.data });
  if (error) {
    if (outcomeOf(error) === 'wrong') return countWrongCode(input, session.email, next);
    return { kind: 'redirect', location: back(failure('verify', error), next) } as const;
  }
  const { error: removeError } = await input.sb.auth.mfa.unenroll({ factorId });
  if (removeError) {
    return { kind: 'redirect', location: back(failure('unenrol', removeError), next) } as const;
  }
  await writeAudit(input.sb, session, {
    action: 'auth.two_step_off',
    entityType: 'profile',
    entityId: session.userId,
  });
  return { kind: 'redirect', location: back(null, next, 'off') } as const;
}

/** What a post to /admin/2fa does. The middleware has checked the origin and the token. */
export async function twoStepFormPost(input: TwoStepPost): Promise<TwoStepResult> {
  const intent = TwoStepIntentSchema.safeParse(field(input.form, 'intent'));
  if (!intent.success || !allowed(input.session, input.pending).includes(intent.data)) {
    return { kind: 'refuse', status: 403 };
  }
  const next = safeNext(field(input.form, 'next') || '/admin');

  switch (intent.data) {
    case 'signout':
      await signOutAll(input.sb, input.session, input.cookies);
      return { kind: 'redirect', location: '/admin/login' };
    case 'verify':
      // allowed() admits it for a pending challenge only.
      return verify(input, input.pending as PendingSecondStep, next);
    case 'start': {
      const email = input.pending?.email ?? input.session?.email ?? '';
      const step = await startEnrolment(input.sb, email, input.brand);
      if (step === 'already-on') return { kind: 'redirect', location: back(null, next) };
      if (step === 'limited' || step === 'unavailable') {
        return { kind: 'redirect', location: back(step, next) };
      }
      return { kind: 'render', status: 200, view: step, error: null };
    }
    case 'confirm':
      return confirm(input, next);
    case 'off':
      return turnOff(input, input.session as AuthContext, next);
  }
}
