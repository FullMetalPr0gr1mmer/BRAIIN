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
//
// The rule is applied to the URL the BROWSER will resolve, not to the string (F7 review):
// `/admin/../services`, `/admin/%2e%2e/x` and `/admin/..//evil.example` all start with
// `/admin/`, yet resolve to `/services`, `/x` and `//evil.example` (the last a path the
// authored redirects, consulted after a 404, could send on to another site). So the value
// is resolved against a placeholder origin, dot segments and all, and what is kept is the
// resolved path, query and fragment. That form is also all ASCII (WHATWG URL serialisation
// percent-encodes the rest): a raw `/admin/日` in a Location header threw ("Cannot convert
// argument to a ByteString") and turned a successful sign-in into a 500.
//
// And to the path ASTRO will route (second review): the browser resolves only `%2e` as a
// dot, but Astro decodes a path up to ten times before it routes and resolves the dots it
// then finds (astro/dist/core/util/normalized-url.js), so `/admin/%252e%252e/old-page`,
// unchanged by the browser, reached the middleware as `/old-page`, and a 404 there is
// answered by the authored redirects. The path is decoded the same way and must still be
// under /admin; one Astro could not decode is refused.

export const DEFAULT_NEXT = '/admin';

const UNSAFE = /[\\\u0000-\u001f\u007f]/;

/** A placeholder origin to resolve against; `.invalid` never resolves (RFC 2606). */
const BASE = 'https://next.invalid';

/** The longest `next` kept, before and after resolving. */
const MAX_NEXT = 2048;

/** Astro's own bound on how many times it decodes a path (MAX_DECODE_ITERATIONS). */
const ASTRO_DECODES = 10;

const isAdminPath = (pathname: string): boolean =>
  pathname === DEFAULT_NEXT || pathname.startsWith(`${DEFAULT_NEXT}/`);

/**
 * The path Astro routes for `pathname`: decodeURI until it stops changing (at most ten
 * times, as Astro), then dot segments resolved and doubled slashes collapsed. Null when it
 * cannot be decoded, or takes more decodings than Astro allows.
 */
function routedPath(pathname: string): string | null {
  let current = pathname;
  for (let i = 0; i <= ASTRO_DECODES; i += 1) {
    let decoded: string;
    try {
      decoded = decodeURI(current);
    } catch {
      return null;
    }
    if (decoded === current) {
      try {
        return new URL(decoded, BASE).pathname.replace(/\/{2,}/g, '/');
      } catch {
        return null;
      }
    }
    current = decoded;
  }
  return null;
}

export function safeNext(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_NEXT) return DEFAULT_NEXT;
  if (!value.startsWith('/') || value.startsWith('//') || UNSAFE.test(value)) {
    return DEFAULT_NEXT;
  }
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return DEFAULT_NEXT;
  }
  if (url.origin !== BASE || !isAdminPath(url.pathname)) return DEFAULT_NEXT;
  const routed = routedPath(url.pathname);
  if (routed === null || !isAdminPath(routed)) return DEFAULT_NEXT;
  const resolved = `${url.pathname}${url.search}${url.hash}`;
  // Belt and braces: what goes into a Location header is ASCII, printable, and still a
  // single-slash path (a resolved `//` would be protocol-relative); and no longer than what
  // was accepted, since percent-encoding can make it up to nine times longer (the sign-in
  // form carries it, under the pre-auth body limit, src/lib/auth/bodyLimit.ts).
  if (resolved.length > MAX_NEXT || !/^\/(?!\/)[\x21-\x7e]*$/.test(resolved)) {
    return DEFAULT_NEXT;
  }
  return resolved;
}
