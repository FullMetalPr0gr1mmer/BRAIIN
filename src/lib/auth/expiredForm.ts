import { RECOVERY_TOKEN_PATTERN } from '@schemas/admin';
import { CSRF_HEADER_NAME } from '@/lib/http/csrf';
import { seeOther } from './body';
import { DEFAULT_NEXT, safeNext } from './next';
import { keepResetToken } from './resetToken';

// A sign-in screen's form post that fails the CSRF check (Admin v2 F7 review).
//
// The three sign-in screens are zero-JS forms, so what a browser shows for a refused post
// is the response itself. The middleware's refusal is a JSON 403, which a person's browser
// renders as `{"ok":false,"error":"csrf"}`: a dead end. And a person meets it in ordinary
// use, because `__Host-csrf` is a session cookie: close the browser with the sign-in page
// open, let it restore the tab, and the token the page carries matches nothing.
//
// So a urlencoded post to one of the three endpoints that fails the token check goes back
// to its page with a fixed code, and the page's GET mints a fresh token. Nothing in the post
// is acted on: the handler never runs. What travels back is only what the page already had:
// `next` on the sign-in page (held to /admin by safeNext), in the URL, and the reset link's
// token (its shape checked), in the reset page's cookie, never the URL, as the reset
// endpoint keeps it for a failure that leaves it unspent (src/lib/auth/resetToken.ts). A
// JSON caller, or anything carrying the token header, keeps the JSON 403.
//
// Only the token check: a cross-site form post never gets this far (Astro's checkOrigin
// answers it first), and a mismatched Origin stays the middleware's JSON 403.

export const EXPIRED_FORM = 'expired-form';

/** Each sign-in endpoint, the page its form is on, and the query key that page reads. */
const SIGN_IN_FORMS: ReadonlyMap<string, { page: string; key: 'error' | 'status' }> = new Map([
  ['/api/admin/auth/login', { page: '/admin/login', key: 'error' }],
  ['/api/admin/auth/forgot', { page: '/admin/forgot', key: 'status' }],
  ['/api/admin/auth/reset', { page: '/admin/reset', key: 'error' }],
]);

/** Where a sign-in form post that failed the token check goes back to, or null. */
export function expiredFormLocation(endpoint: string, fields: URLSearchParams): string | null {
  const form = SIGN_IN_FORMS.get(endpoint);
  if (!form) return null;
  const params = new URLSearchParams();
  if (form.page === '/admin/login') {
    const next = safeNext(fields.get('next'));
    if (next !== DEFAULT_NEXT) params.set('next', next);
  }
  params.set(form.key, EXPIRED_FORM);
  return `${form.page}?${params}`;
}

/** The reset link's token a form post carried, when it has the right shape. */
function postedResetToken(endpoint: string, fields: URLSearchParams): string | null {
  if (endpoint !== '/api/admin/auth/reset') return null;
  const token = fields.get('token_hash');
  return token !== null && RECOVERY_TOKEN_PATTERN.test(token) ? token : null;
}

/**
 * The 303 for a sign-in screen's form post that failed the CSRF check, or null when the
 * request is anything else (another path, JSON, a script sending the token header).
 */
export async function expiredSignInForm(
  request: Request,
  pathname: string,
): Promise<Response | null> {
  if (!SIGN_IN_FORMS.has(pathname) || request.headers.has(CSRF_HEADER_NAME)) return null;
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!type.includes('application/x-www-form-urlencoded')) return null;
  let fields: URLSearchParams;
  try {
    fields = new URLSearchParams(await request.clone().text());
  } catch {
    fields = new URLSearchParams();
  }
  const location = expiredFormLocation(pathname, fields);
  if (location === null) return null;
  const res = seeOther(location);
  const token = postedResetToken(pathname, fields);
  if (token !== null) res.headers.append('set-cookie', keepResetToken(token));
  return res;
}
