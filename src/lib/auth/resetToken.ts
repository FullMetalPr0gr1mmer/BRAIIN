import { RECOVERY_TOKEN_PATTERN } from '@schemas/admin';

// How a reset link's token comes back to the page after a form post that left it unspent
// (Admin v2 F7, final review).
//
// The reset e-mail's link carries the token in its query string (`?token_hash=…`, the
// recovery template, launch runbook §2b), so the click, and a mail scanner's prefetch, put
// it in the URL of a request, which the platform's request logs record (Workers Logs: a
// residual risk, docs/admin-v2/deviations.md). Until the F7 review every 303 back to the
// page for a failure that keeps the link (a mismatch, a short password, a limit, an outage,
// a form left open too long) put it in the URL again, one more logged request each.
//
// Now the 303 goes to `/admin/reset?error=<code>` and the token rides in a cookie the page
// reads instead: `__Secure-` (Secure is required of it by the browser), HttpOnly, SameSite
// Strict, Path=/admin/reset so no other request carries it (a `__Host-` cookie would need
// Path=/ and go with every request), and 15 minutes long (the link itself lasts an hour; the
// person can open it again). The page's hidden field still posts it, so the form is as
// zero-JS as before. The page drops it as soon as the token is in its form (second review),
// and every outcome that spends the link, or sets the password, clears it too, so the next
// person on the browser is not offered the link.
//
// Unlike `__Host-`, a `__Secure-` cookie may carry a Domain attribute, so a sibling
// subdomain could plant one here. Harmless: the page takes only a value of the token's
// shape, and the auth server verifies it, so a planted value is at worst a link that is not
// valid. (`__Host-` would rule that out, at the price of Path=/.)

export const RESET_TOKEN_COOKIE = '__Secure-braiin-reset';
export const RESET_PAGE = '/admin/reset';
export const RESET_TOKEN_MAX_AGE_SECONDS = 15 * 60;

const ATTRIBUTES = `Path=${RESET_PAGE}; Secure; HttpOnly; SameSite=Strict`;

/** The Set-Cookie value that carries an unspent token back to the page. */
export function keepResetToken(token: string): string {
  if (!RECOVERY_TOKEN_PATTERN.test(token)) throw new Error('not a recovery token');
  return `${RESET_TOKEN_COOKIE}=${token}; Max-Age=${RESET_TOKEN_MAX_AGE_SECONDS}; ${ATTRIBUTES}`;
}

/** The Set-Cookie value that drops it (same Path, or the browser keeps the cookie). */
export function dropResetToken(): string {
  return `${RESET_TOKEN_COOKIE}=; Max-Age=0; ${ATTRIBUTES}`;
}

/** The same deletion through Astro's cookie jar (the page's own response). */
export function dropResetTokenOptions() {
  return { path: RESET_PAGE, secure: true, httpOnly: true, sameSite: 'strict' } as const;
}

/**
 * The token a request to the page carries: the link's own (`?token_hash=…&type=recovery`,
 * a click from the e-mail) first, else the one a 303 left in the cookie. Null when neither
 * has a token of the right shape.
 */
export function resetTokenFrom(params: URLSearchParams, cookie: string | undefined): string | null {
  const fromLink = params.get('token_hash');
  if (fromLink !== null) {
    return params.get('type') === 'recovery' && RECOVERY_TOKEN_PATTERN.test(fromLink)
      ? fromLink
      : null;
  }
  return cookie !== undefined && RECOVERY_TOKEN_PATTERN.test(cookie) ? cookie : null;
}
