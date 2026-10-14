import { LOCKOUT_DURATION_MINUTES } from './lockout';
import { PASSWORD_MIN } from '@schemas/adminPrefs';

// What the sign-in screens say about an outcome (Admin v2 F7). The endpoints answer a form
// post with a 303 carrying a CODE (src/pages/api/admin/auth/*.ts); the page looks the code
// up here and renders fixed copy. So nothing typed, and nothing an attacker writes into a
// link, is ever echoed: an unknown code renders nothing. Admin copy rules (P-12): plain,
// warm, no em or en dashes (tests/lib/authScreens.spec.ts).

export type MessageKind = 'error' | 'ok' | 'info';

export interface PageMessage {
  kind: MessageKind;
  text: string;
}

const msg = (kind: MessageKind, text: string): PageMessage => ({ kind, text });

/**
 * A form post that failed the CSRF check, sent back to its page (src/lib/auth/expiredForm.ts):
 * the page was open longer than its token lasts (a session cookie), or the browser dropped it.
 */
const EXPIRED_FORM_MESSAGE = msg('error', 'This page was open too long. Please try again.');

/** A form post over the pre-auth body limit, sent back unread (src/lib/auth/bodyLimit.ts). */
const TOO_LARGE_MESSAGE = msg('error', 'That form was too large to send. Please try again.');

/** /admin/login?error=… and ?reset=done. */
export const LOGIN_MESSAGES = {
  // One message for every failed sign-in: the endpoint already refuses to tell them
  // apart, and the page must not hand back the enumeration oracle it took away.
  invalid: msg('error', 'Those credentials did not work.'),
  locked: msg('error', `Too many attempts. Try again in ${LOCKOUT_DURATION_MINUTES} minutes.`),
  unavailable: msg('error', 'Signing in is not available right now. Try again in a few minutes.'),
  'expired-form': EXPIRED_FORM_MESSAGE,
  'too-large': TOO_LARGE_MESSAGE,
} as const;

// A reset does not lift a sign-in lockout (src/lib/auth/lockout.ts: the failures stay in
// their 15-minute window, which only a migration could clear; F7 takes none). The common way
// here is a few wrong passwords and then "Forgot password?", so the notice says so rather
// than leave the new password answered with "Too many attempts" unexplained (F7 review).
export const RESET_DONE = msg(
  'ok',
  `Your password is changed, and every session of your account is signed out. Sign in with the new password. If sign-in was locked after too many attempts, it opens again within ${LOCKOUT_DURATION_MINUTES} minutes.`,
);

/** /admin/forgot?status=… */
export const FORGOT_MESSAGES = {
  // The same words for every address, known or not (the endpoint's one answer).
  sent: msg(
    'ok',
    'If that email belongs to an account here, a link to choose a new password is on its way. The link works for one hour.',
  ),
  limited: msg('error', 'Too many requests. Try again in an hour.'),
  unavailable: msg('error', 'Something went wrong on our side. Try again in a few minutes.'),
  'expired-form': EXPIRED_FORM_MESSAGE,
  'too-large': TOO_LARGE_MESSAGE,
} as const;

/** What the forgot screen says while Supabase cannot send e-mail (owner item O-2). */
export const FORGOT_NOT_SET_UP = {
  title: 'Not set up',
  text: 'This site cannot send password emails yet. Ask an Admin to help you sign in.',
} as const;

/** /admin/reset?error=… */
export const RESET_MESSAGES = {
  expired: msg('error', 'This reset link is not valid, has been used, or has expired.'),
  // The account screen's words for the same rule (F8, packages/schemas/adminPrefs.ts).
  short: msg('error', `Use at least ${PASSWORD_MIN} characters.`),
  long: msg('error', 'That password is too long. Try a shorter one.'),
  mismatch: msg('error', 'The two passwords do not match.'),
  // Our own limit (an hour's window) or Supabase's (shorter): the link is still good.
  limited: msg(
    'error',
    'Too many attempts. Try again later; this link still works until it expires.',
  ),
  unavailable: msg('error', 'Something went wrong on our side. Try again in a few minutes.'),
  refused: msg(
    'error',
    'That password was not accepted. It may be too common, or the same as your last one. The link is now used up, so ask for a new one.',
  ),
  interrupted: msg(
    'error',
    'Something went wrong on our side, and the link is now used up. Ask for a new one.',
  ),
  // The link is untouched (the endpoint never ran): the form comes back with it.
  'expired-form': EXPIRED_FORM_MESSAGE,
  'too-large': TOO_LARGE_MESSAGE,
} as const;

/** The reset codes that leave the person without a usable link (the page drops the form). */
export const RESET_LINK_SPENT: ReadonlySet<string> = new Set(['expired', 'refused', 'interrupted']);

/** A code from the query string → its message, or null for anything not on the list. */
export function messageFor<T extends Record<string, PageMessage>>(
  table: T,
  code: string | null,
): PageMessage | null {
  if (code === null || !Object.prototype.hasOwnProperty.call(table, code)) return null;
  return table[code as keyof T] ?? null;
}
