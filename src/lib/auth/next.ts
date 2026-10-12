// Where a sign-in sends the browser afterwards: the `?next=` the login page was opened with
// (the middleware adds it when it turns a signed-out visitor away from an admin screen).
//
// `?next=` is an OPEN REDIRECT if taken at face value: an attacker sends
// `/admin/login?next=https://evil.example/admin`, the victim signs in on the real domain,
// and lands on a copy that asks them to "sign in again". So only a site-relative path
// under /admin is kept. Rejecting anything that does not start with a single `/` kills
// absolute URLs, and rejecting `//` kills the protocol-relative form that looks relative
// but is not. A backslash is refused as well (browsers read `/\evil.example` as
// `//evil.example`), and so is a control character. Shared by the login page and the
// endpoint its no-JS form posts to, so the rule cannot differ between the two.

export const DEFAULT_NEXT = '/admin';

const UNSAFE = /[\\\u0000-\u001f\u007f]/;

export function safeNext(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) return DEFAULT_NEXT;
  if (!value.startsWith('/') || value.startsWith('//') || UNSAFE.test(value)) {
    return DEFAULT_NEXT;
  }
  return value === DEFAULT_NEXT || /^\/admin[/?#]/.test(value) ? value : DEFAULT_NEXT;
}
