import { RECOVERY_TOKEN_PATTERN } from '@schemas/admin';

// How an invite link's token comes back to the invite page after a form post that left it
// unspent (Admin v2 U12b): the reset link's rule (src/lib/auth/resetToken.ts), for the page
// the invite e-mail opens.
//
// The invite e-mail's link carries the token in its query string
// (`/admin/invite?token_hash=…&type=invite`, supabase/templates/invite.html, launch runbook
// §2b), so the click puts it in a logged request URL once. A failure that keeps the link (a
// mismatch, a short password, a limit, an outage, a form left open too long) goes back to
// `/admin/invite?error=<code>` with the token in a cookie only that page gets: `__Secure-`,
// HttpOnly, SameSite Strict, Path=/admin/invite, 15 minutes (the link itself lasts an hour,
// decision D1). The page drops it as soon as the token is in its form, and every outcome that
// spends the link, or sets the password, clears it too. A planted value (a `__Secure-`
// cookie may carry a Domain) is at worst a link that is not valid: the page takes only a
// value of the token's shape, and the auth server verifies it.

export const INVITE_TOKEN_COOKIE = '__Secure-braiin-invite';
export const INVITE_PAGE = '/admin/invite';
export const INVITE_TOKEN_MAX_AGE_SECONDS = 15 * 60;

const ATTRIBUTES = `Path=${INVITE_PAGE}; Secure; HttpOnly; SameSite=Strict`;

/** The Set-Cookie value that carries an unspent token back to the page. */
export function keepInviteToken(token: string): string {
  if (!RECOVERY_TOKEN_PATTERN.test(token)) throw new Error('not an invite token');
  return `${INVITE_TOKEN_COOKIE}=${token}; Max-Age=${INVITE_TOKEN_MAX_AGE_SECONDS}; ${ATTRIBUTES}`;
}

/** The Set-Cookie value that drops it (same Path, or the browser keeps the cookie). */
export function dropInviteToken(): string {
  return `${INVITE_TOKEN_COOKIE}=; Max-Age=0; ${ATTRIBUTES}`;
}

/** The same deletion through Astro's cookie jar (the page's own response). */
export function dropInviteTokenOptions() {
  return { path: INVITE_PAGE, secure: true, httpOnly: true, sameSite: 'strict' } as const;
}

/**
 * The token a request to the page carries: the link's own (`?token_hash=…&type=invite`, a
 * click from the e-mail) first, else the one a 303 left in the cookie. Null when neither has
 * a token of the right shape. A reset link's token (`type=recovery`) is not an invite's.
 */
export function inviteTokenFrom(
  params: URLSearchParams,
  cookie: string | undefined,
): string | null {
  const fromLink = params.get('token_hash');
  if (fromLink !== null) {
    return params.get('type') === 'invite' && RECOVERY_TOKEN_PATTERN.test(fromLink)
      ? fromLink
      : null;
  }
  return cookie !== undefined && RECOVERY_TOKEN_PATTERN.test(cookie) ? cookie : null;
}
