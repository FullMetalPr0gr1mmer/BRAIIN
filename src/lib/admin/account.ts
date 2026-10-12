import type { AstroCookies } from 'astro';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { clearSessionCookies } from '@/lib/auth/session';
import { isLockedOut, registerFailure } from '@/lib/auth/lockout';
import { AuthorizationError } from '@/lib/authz/errors';
import { ROLE_LABELS, capLinesFor } from '@/lib/authz/capLabels';
import type { PasswordChangeInput } from '@schemas/adminPrefs';
import { writeAudit } from './audit';
import { ValidationError } from './errors';
import { initialsOf } from './initials';
import { writeSystemLog } from '@/lib/data/systemLog';

// The signed-in person's account (Admin v2 F8, docs/admin-v2/ui.md §2.9): what the
// account drawer and /admin/account show, and the three things a person changes about
// themselves. Shared by the JSON routes (the drawer) and the no-JS page, so both paths
// run the same checks in the same order.

/** What the account drawer and page show. Built on the server; no capability map ships. */
export interface AccountView {
  displayName: string | null;
  email: string;
  role: string;
  initials: string;
  /** "What you can do", one plain line per capability (src/lib/authz/capLabels.ts). */
  can: string[];
  /** Who changes this person's access. */
  accessNote: string;
}

/** The outcome of a form just posted on /admin/account, shown beside that form. */
export interface AccountFlash {
  form: 'name' | 'password';
  kind: 'ok' | 'error';
  text: string;
  /** The field an error belongs to. */
  field?: string | undefined;
}

export function accountViewFor(auth: AuthContext, displayName: string | null): AccountView {
  return {
    displayName,
    email: auth.email,
    role: ROLE_LABELS[auth.role],
    initials: initialsOf(displayName, auth.email),
    can: capLinesFor(auth.role),
    accessNote:
      auth.role === 'admin'
        ? 'You change people’s access in Users & roles.'
        : 'Ask an Admin to change your access.',
  };
}

// ── The name ──────────────────────────────────────────────────────────────────────

/**
 * Renames the caller through `update_my_profile()` (0044): a definer that writes one
 * column of the caller's own row after its own live check, because `profiles` is Admin
 * write only. It applies the schema's name rules again and writes the `profile.update`
 * audit row in the same transaction, so no caller audits a rename itself. Returns the
 * stored name (null when cleared).
 */
export async function updateMyDisplayName(
  sb: SupabaseClient,
  auth: AuthContext,
  displayName: string,
): Promise<string | null> {
  const { data, error } = await sb.rpc('update_my_profile', {
    p_tenant: auth.tenantId,
    p_display_name: displayName,
  });
  if (error?.code === '22023') {
    throw new ValidationError(
      'Use 80 characters or fewer, with no special characters.',
      'display_name',
    );
  }
  if (error?.code === '42501') throw new AuthorizationError('profile', 'not a live member');
  if (error) throw new Error(`update_my_profile: ${error.message}`);
  return typeof data === 'string' ? data : null;
}

// ── The password ──────────────────────────────────────────────────────────────────

export type PasswordOutcome =
  | { ok: true; othersSignedOut: boolean }
  | { ok: false; reason: 'locked' | 'wrong-current' | 'same' | 'weak' | 'failed' };

/** The copy each refusal shows, beside the field it belongs to. */
export const PASSWORD_REFUSALS: Readonly<
  Record<Exclude<PasswordOutcome, { ok: true }>['reason'], { field: string; message: string }>
> = {
  locked: {
    field: 'current',
    message:
      'Too many wrong tries. Your account is locked for 15 minutes, and you will need to sign in again.',
  },
  'wrong-current': { field: 'current', message: 'That is not your current password.' },
  same: { field: 'next', message: 'Choose a password you have not used here before.' },
  weak: { field: 'next', message: 'That password is too easy to guess. Try a longer one.' },
  failed: { field: 'next', message: 'Your password could not be changed just now. Try again.' },
};

/** What an auth-js error carries: GoTrue's error code, and the HTTP status (0 offline). */
interface AuthErrorLike {
  code?: unknown;
  status?: unknown;
}

/**
 * True only when GoTrue refused the password itself: `invalid_credentials`, or a 400 with
 * no code (an auth server that predates error codes answers a wrong password that way).
 * A rate limit, an outage, a network error or a captcha refusal is not the person's
 * mistake, so it must not count toward their lockout.
 */
function isWrongPassword(error: AuthErrorLike): boolean {
  return error.code === 'invalid_credentials' || (error.code == null && error.status === 400);
}

/** A failure at the auth server, logged with its status and code only, never a password. */
function logAuthFailure(step: 're-authentication' | 'update', error: AuthErrorLike): void {
  void writeSystemLog({
    level: 'error',
    source: 'admin:account',
    message: `password change failed at the auth server (${step})`,
    detail: {
      status: typeof error.status === 'number' ? error.status : null,
      code: typeof error.code === 'string' ? error.code : null,
    },
  });
}

/**
 * Changes the caller's password through the admin (CLAUDE.md §3, Pillar 1):
 *   1. A locked account is refused before anything is tried.
 *   2. The current password re-authenticates the person. A wrong one counts toward the
 *      sign-in lockout (5 in 15 minutes), so an unattended session cannot change the
 *      password through this route; the fifth locks the account, and the next request
 *      ends this session too (resolveAuthContext refuses a locked profile). A refusal
 *      at this step is audited; an auth server that cannot check the password counts
 *      nothing (see isWrongPassword).
 *   3. The new password is set on the fresh session the re-authentication returned (the
 *      session client writes it into the `__Host-` cookie), with the current password
 *      sent again as `current_password`, and every OTHER session is signed out, so a
 *      password changed because it leaked takes the leaker's sessions with it. Audited.
 *
 * WHAT THIS DOES NOT COVER. These checks are the Worker's. Supabase Auth's own
 * `PUT /auth/v1/user` is public (the project URL and the anon key ship to browsers), and
 * with the session's access token alone it changes the password with no lockout count
 * and no audit row, and with no current password unless the project requires one
 * (GoTrue's `security_update_password_require_current_password`, which the local stack
 * cannot set). That residual and the owner's action that closes it (O-24: require the
 * current password, a minimum length of 10, Secure password change) are recorded in
 * docs/admin-v2/deviations.md and the launch runbook §2a. Sending `current_password`
 * here is what keeps this route working once the setting is on: the fresh session makes
 * Secure password change ask for no e-mailed code, and the current password satisfies
 * the requirement, so neither depends on SMTP (O-2).
 *
 * The password never leaves this function: not in the audit row, a log or a response.
 */
export async function changeMyPassword(
  sb: SupabaseClient,
  auth: AuthContext,
  input: Pick<PasswordChangeInput, 'current' | 'next'>,
  ip: string | null,
): Promise<PasswordOutcome> {
  const refuse = async (reason: 'locked' | 'wrong-current'): Promise<PasswordOutcome> => {
    await writeAudit(sb, auth, {
      action: 'auth.password_change_refused',
      entityType: 'profile',
      entityId: auth.userId,
      detail: { reason },
    });
    return { ok: false, reason };
  };

  if (await isLockedOut(auth.email)) return refuse('locked');

  const { error: authError } = await sb.auth.signInWithPassword({
    email: auth.email,
    password: input.current,
  });
  if (authError) {
    // Only a refused password is the person's wrong try. Anything else (a 429, a 5xx, the
    // network, a captcha the auth server asks for) is a failure to check, not a failed
    // check: it counts nothing, and the person is told to try again.
    if (!isWrongPassword(authError)) {
      logAuthFailure('re-authentication', authError);
      return { ok: false, reason: 'failed' };
    }
    const nowLocked = await registerFailure(auth.email, ip);
    return refuse(nowLocked ? 'locked' : 'wrong-current');
  }

  const { error: updateError } = await sb.auth.updateUser({
    password: input.next,
    current_password: input.current,
  });
  if (updateError) {
    const code = (updateError as AuthErrorLike).code;
    if (code === 'same_password') return { ok: false, reason: 'same' };
    if (code === 'weak_password') return { ok: false, reason: 'weak' };
    // The auth server's own current-password check (O-24) refused it: the password changed
    // since the re-authentication a moment ago. The person's wrong try, so it counts.
    if (code === 'current_password_invalid') {
      const nowLocked = await registerFailure(auth.email, ip);
      return refuse(nowLocked ? 'locked' : 'wrong-current');
    }
    logAuthFailure('update', updateError);
    return { ok: false, reason: 'failed' };
  }

  const { error: signOutError } = await sb.auth.signOut({ scope: 'others' });
  const othersSignedOut = !signOutError;
  await writeAudit(sb, auth, {
    action: 'auth.password_change',
    entityType: 'profile',
    entityId: auth.userId,
    detail: { otherSessionsEnded: othersSignedOut },
  });
  return { ok: true, othersSignedOut };
}

// ── Signing out ───────────────────────────────────────────────────────────────────

/**
 * Ends the session: an audit row, the refresh token revoked at the auth server FIRST (so a
 * failure later still leaves the session dead), then the cookie cleared either way. Used
 * by POST /api/admin/auth/logout and the account page's no-JS form.
 */
export async function endSession(
  sb: SupabaseClient,
  auth: AuthContext | null,
  cookies: AstroCookies,
): Promise<void> {
  if (auth) {
    await writeAudit(sb, auth, {
      action: 'auth.logout',
      entityType: 'profile',
      entityId: auth.userId,
    });
  }
  try {
    await sb.auth.signOut();
  } catch {
    // A network failure to GoTrue must not strand the browser holding a cookie: clearing
    // it below is the part the person can observe, so it happens either way.
  }
  clearSessionCookies(cookies);
}
