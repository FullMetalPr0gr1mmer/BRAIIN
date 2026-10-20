import { RECOVERY_TOKEN_PATTERN } from '@schemas/admin';
import { csrfHeaderToken } from '@/lib/http/csrf';
import { seeOther } from './body';
import { DEFAULT_NEXT, safeNext } from './next';
import { keepResetToken } from './resetToken';
import { keepInviteToken } from './inviteToken';
import { TWO_STEP_PATH } from './twoStep';

// A sign-in screen's form post that fails the CSRF check (Admin v2 F7 review).
//
// The sign-in screens (sign in, forgot, reset, and since Admin v2 U12b the invite page) are
// zero-JS forms, so what a browser shows for a refused post
// is the response itself. The middleware's refusal is a JSON 403, which a person's browser
// renders as `{"ok":false,"error":"csrf"}`: a dead end. And a person meets it in ordinary
// use, because `__Host-csrf` is a session cookie: close the browser with the sign-in page
// open, let it restore the tab, and the token the page carries matches nothing.
//
// The two-step page (Admin v2 U17, /admin/2fa) is one of them too: a zero-JS page reached with
// a session (or one still owing its code), whose forms post to the page itself. It goes back
// to itself with its `next`, as the sign-in page does.
//
// So a urlencoded post to one of their endpoints that fails the token check goes back
// to its page with a fixed code, and the page's GET mints a fresh token. Nothing in the post
// is acted on: the handler never runs. What travels back is only what the page already had:
// `next` on the sign-in page (held to /admin by safeNext), in the URL, and the reset or
// invite link's token (its shape checked), in that page's own cookie, never the URL, as its
// endpoint keeps it for a failure that leaves it unspent (src/lib/auth/resetToken.ts,
// src/lib/auth/inviteToken.ts). A JSON caller, or anything carrying the token header, keeps
// the JSON 403.
//
// Only the token check: a cross-site form post never gets this far (Astro's checkOrigin
// answers it first), and a mismatched Origin stays the middleware's JSON 403.
//
// A form whose body is over the pre-auth limit (src/lib/auth/bodyLimit.ts) goes back the
// same way, with `too-large`, before anything reads it: so nothing of it travels back, not
// even `next` or the reset link. Nor is the link in the reset page's cookie by then: the page
// drops that cookie in the response that puts the link in its form, the form this post came
// from. So the reset page comes back without the link, says the form was too large and to
// open the link again (`RESET_TOO_LARGE`, src/lib/auth/messages.ts), which is true: the
// endpoint never ran, so the link is not spent. A script's post gets a JSON 413.

export const EXPIRED_FORM = 'expired-form';
export const FORM_TOO_LARGE = 'too-large';

/** Each sign-in endpoint, the page its form is on, and the query key that page reads. */
const SIGN_IN_FORMS: ReadonlyMap<string, { page: string; key: 'error' | 'status' }> = new Map([
  ['/api/admin/auth/login', { page: '/admin/login', key: 'error' }],
  ['/api/admin/auth/forgot', { page: '/admin/forgot', key: 'status' }],
  ['/api/admin/auth/reset', { page: '/admin/reset', key: 'error' }],
  ['/api/admin/auth/invite', { page: '/admin/invite', key: 'error' }],
  [TWO_STEP_PATH, { page: TWO_STEP_PATH, key: 'error' }],
]);

/** The pages whose form carries a `next` that goes back with it (held to /admin by safeNext). */
const KEEPS_NEXT: ReadonlySet<string> = new Set(['/admin/login', TWO_STEP_PATH]);

/** Where a sign-in form post that failed the token check goes back to, or null. */
export function expiredFormLocation(endpoint: string, fields: URLSearchParams): string | null {
  const form = SIGN_IN_FORMS.get(endpoint);
  if (!form) return null;
  const params = new URLSearchParams();
  if (KEEPS_NEXT.has(form.page)) {
    const next = safeNext(fields.get('next'));
    if (next !== DEFAULT_NEXT) params.set('next', next);
  }
  params.set(form.key, EXPIRED_FORM);
  return `${form.page}?${params}`;
}

/** The page cookie that keeps a link's token, per endpoint whose form carries one. */
const KEEP_TOKEN: ReadonlyMap<string, (token: string) => string> = new Map([
  ['/api/admin/auth/reset', keepResetToken],
  ['/api/admin/auth/invite', keepInviteToken],
]);

/** The Set-Cookie that keeps the link's token a form post carried, when it has the right shape. */
function keptLinkToken(endpoint: string, fields: URLSearchParams): string | null {
  const keep = KEEP_TOKEN.get(endpoint);
  if (!keep) return null;
  const token = fields.get('token_hash');
  return token !== null && RECOVERY_TOKEN_PATTERN.test(token) ? keep(token) : null;
}

/**
 * True for a sign-in screen's own form post: one of their endpoints, urlencoded, and no
 * token header (a script sends one; a form cannot), as the middleware reads "no token header"
 * (`csrfHeaderToken`: an empty one is none). Reads nothing of the body.
 */
function isSignInFormPost(request: Request, pathname: string): boolean {
  if (!SIGN_IN_FORMS.has(pathname) || csrfHeaderToken(request) !== null) return false;
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  return type.includes('application/x-www-form-urlencoded');
}

/**
 * The 303 for a sign-in screen's form post whose body is over the pre-auth limit, or null
 * when the request is anything else. Reads nothing of the body.
 */
export function tooLargeSignInForm(request: Request, pathname: string): Response | null {
  const form = SIGN_IN_FORMS.get(pathname);
  if (!form || !isSignInFormPost(request, pathname)) return null;
  return seeOther(`${form.page}?${new URLSearchParams({ [form.key]: FORM_TOO_LARGE })}`);
}

/**
 * The 303 for a sign-in screen's form post that failed the CSRF check, or null when the
 * request is anything else (another path, JSON, a script sending the token header).
 */
export async function expiredSignInForm(
  request: Request,
  pathname: string,
): Promise<Response | null> {
  if (!isSignInFormPost(request, pathname)) return null;
  let fields: URLSearchParams;
  try {
    fields = new URLSearchParams(await request.clone().text());
  } catch {
    fields = new URLSearchParams();
  }
  const location = expiredFormLocation(pathname, fields);
  if (location === null) return null;
  const res = seeOther(location);
  const kept = keptLinkToken(pathname, fields);
  if (kept !== null) res.headers.append('set-cookie', kept);
  return res;
}
