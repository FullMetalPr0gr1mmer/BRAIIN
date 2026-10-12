import { LOCKOUT_DURATION_MINUTES } from './lockout';
import { NEW_PASSWORD_MAX, NEW_PASSWORD_MIN } from '@schemas/admin';

// What the sign-in screens say about an outcome (Admin v2 F7). The endpoints answer a form
// post with a 303 carrying a CODE (src/pages/api/admin/auth/*.ts); the page looks the code
// up here and renders fixed copy. So nothing typed, and nothing an attacker writes into a
// link, is ever echoed: an unknown code renders nothing. Admin copy rules (P-12): plain,
// warm, no em or en dashes (tests/lib/authMessages.spec.ts).

export type MessageKind = 'error' | 'ok' | 'info';

export interface PageMessage {
  kind: MessageKind;
  text: string;
}

const msg = (kind: MessageKind, text: string): PageMessage => ({ kind, text });

/** /admin/login?error=… and ?reset=done. */
export const LOGIN_MESSAGES = {
  // One message for every failed sign-in: the endpoint already refuses to tell them
  // apart, and the page must not hand back the enumeration oracle it took away.
  invalid: msg('error', 'Those credentials did not work.'),
  locked: msg('error', `Too many attempts. Try again in ${LOCKOUT_DURATION_MINUTES} minutes.`),
  unavailable: msg('error', 'Signing in is not available right now. Try again in a few minutes.'),
} as const;

export const RESET_DONE = msg(
  'ok',
  'Your password is changed, and every session of your account is signed out. Sign in with the new password.',
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
} as const;

/** What the forgot screen says while Supabase cannot send e-mail (owner item O-2). */
export const FORGOT_NOT_SET_UP = {
  title: 'Not set up',
  text: 'This site cannot send password emails yet. Ask an Admin to help you sign in.',
} as const;

/** /admin/reset?error=… */
export const RESET_MESSAGES = {
  expired: msg('error', 'This reset link is not valid, has been used, or has expired.'),
  length: msg('error', `Use ${NEW_PASSWORD_MIN} to ${NEW_PASSWORD_MAX} characters.`),
  mismatch: msg('error', 'The two passwords do not match.'),
  limited: msg('error', 'Too many attempts. Try again in an hour.'),
  unavailable: msg('error', 'Something went wrong on our side. Try again in a few minutes.'),
  refused: msg(
    'error',
    'That password was not accepted. It may be too common, or the same as your last one. The link is now used up, so ask for a new one.',
  ),
} as const;

/** The reset codes that leave the person without a usable link (the page drops the form). */
export const RESET_LINK_SPENT: ReadonlySet<string> = new Set(['expired', 'refused']);

/** A code from the query string → its message, or null for anything not on the list. */
export function messageFor<T extends Record<string, PageMessage>>(
  table: T,
  code: string | null,
): PageMessage | null {
  if (code === null || !Object.prototype.hasOwnProperty.call(table, code)) return null;
  return table[code as keyof T] ?? null;
}
