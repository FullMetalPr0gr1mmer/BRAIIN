import type { Role } from './types';

// Two-step sign-in (2FA, TOTP; Admin v2 U17): the rule, in one pure module that the session
// check, the middleware, the /admin/2fa page and the tests share.
//
// A person must be at `aal2` (their code typed in this session) when they have a VERIFIED
// factor, or when their tenant requires 2FA (admin_security_settings.require_mfa). The
// database holds the same rule in app.mfa_required and the access-token hook
// (supabase/migrations/0072_two_step_sign_in.sql): below the required level the token carries
// no role, so RLS treats it as anon. The Worker is stricter, never looser: the hook can only
// ask "is this token at aal2 when aal2 is required", while the Worker also sends a person
// whose tenant requires 2FA but who has none to set it up, whatever their token says (an aal2
// session whose factor was just reset must set one up again).
//
// The case table in tests/lib/twoStep.spec.ts is the one supabase/tests/two_step.test.sql runs
// on the hook: keep the two visibly equal.

export type Aal = 'aal1' | 'aal2';

/** What a session below the required level must do next. */
export type SecondStep = 'challenge' | 'enrol';

/** The one page a session below the required level reaches (with sign-out). */
export const TWO_STEP_PATH = '/admin/2fa';

/** A session that passed the password but not yet the second step (no AuthContext). */
export interface PendingSecondStep {
  readonly userId: string;
  readonly tenantId: string;
  readonly email: string;
  readonly role: Role;
  readonly mode: SecondStep;
  /** The verified authenticator app to challenge; null when there is none. */
  readonly factorId: string | null;
}

/** A full session's 2FA, for the account row and the Security card's precondition. */
export interface TwoStepState {
  /** A verified authenticator app (and, the session being full, this session typed its code). */
  readonly on: boolean;
  /** The tenant requires 2FA for everyone. */
  readonly required: boolean;
  /** The verified authenticator app, for turning it off; null when there is none. */
  readonly factorId: string | null;
}

/**
 * The rule, exactly: a verified factor and a session not at aal2 must type the code; else a
 * tenant that requires 2FA and a person without a factor must set one up (whatever the aal);
 * else nothing.
 */
export function secondStepNeeded(input: {
  verifiedFactor: boolean;
  tenantRequires: boolean;
  aal: Aal | null;
}): SecondStep | null {
  if (input.verifiedFactor && input.aal !== 'aal2') return 'challenge';
  if (input.tenantRequires && !input.verifiedFactor) return 'enrol';
  return null;
}

/** One factor as GoTrue's user record lists it (`getUser().data.user.factors`). */
export interface FactorLike {
  readonly id?: unknown;
  readonly factor_type?: unknown;
  readonly status?: unknown;
}

/**
 * What a user's factors say: whether any is verified (any type counts, as in the database:
 * a phone factor, if ever switched on, must not weaken the rule) and the verified
 * authenticator app to challenge. Anything not in GoTrue's shape counts as nothing.
 */
export function factorsOf(factors: readonly FactorLike[] | null | undefined): {
  verified: boolean;
  totpId: string | null;
} {
  let verified = false;
  let totpId: string | null = null;
  for (const factor of Array.isArray(factors) ? factors : []) {
    if (factor === null || typeof factor !== 'object' || factor.status !== 'verified') continue;
    verified = true;
    if (totpId === null && factor.factor_type === 'totp' && typeof factor.id === 'string') {
      totpId = factor.id;
    }
  }
  return { verified, totpId };
}

/** True when the user has a verified authenticator app. */
export function hasVerifiedTotp(user: { factors?: readonly FactorLike[] | null }): boolean {
  return factorsOf(user.factors).totpId !== null;
}

/** The token's assurance level, leniently: anything but aal1/aal2 is unknown (below aal2). */
export function aalOf(value: unknown): Aal | null {
  return value === 'aal1' || value === 'aal2' ? value : null;
}
