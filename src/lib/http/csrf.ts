// Shared same-origin (CSRF) check for state-changing / cost-bearing endpoints (CLAUDE.md
// §7 — "double-submit __Host-csrf OR same-origin check on every mutation"). Single source
// of truth so contact + ai/style-finder (and future mutations) can't drift. Pure + tested.

/**
 * True when the request is safe to process on origin grounds:
 * - no `Origin` header (same-site navigation / non-CORS request) → allow
 * - `Origin` host matches `Host` → allow
 * - mismatch or malformed `Origin` → reject
 */
export function isSameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin || !host) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * True when a GET that costs something (the CSV exports: a rate-limit slot and two audit
 * rows, Admin v2 U13 review) came from this site, not from another site's page. Those are
 * GETs a person follows as plain links, and the session cookie is SameSite=Lax, so a
 * top-level navigation from another site carries it; Astro's origin check covers only
 * non-GET methods. Refused: `Sec-Fetch-Site` saying another site (`cross-site`, or
 * `same-site`, a sibling host: the admin is one origin), an `Origin` from another host, a
 * `Referer` from another host or one that does not parse. Allowed: this origin, `none` (a
 * typed address or a bookmark) and a request with none of the three headers (a script, a
 * browser that sends none), which the export's session and capabilities still gate.
 */
export function isSameSiteGet(request: Request): boolean {
  const headers = request.headers;
  const host = headers.get('host') ?? new URL(request.url).host;
  const site = headers.get('sec-fetch-site');
  if (site === 'cross-site' || site === 'same-site') return false;
  if (!isSameOrigin(headers.get('origin'), host)) return false;
  const referer = headers.get('referer');
  if (referer) {
    try {
      if (new URL(referer).host !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// ── Double-submit token (the admin half of the same rule) ───────────────────────
// The origin check above is necessary but not sufficient for /admin: `Origin` is absent
// on ordinary same-site form navigations, and `isSameOrigin` deliberately allows that
// case — which is exactly the shape a classic cross-site form POST can take. So every
// admin mutation ALSO has to echo a secret the attacker's page cannot read: a random
// token stored in a `__Host-csrf` cookie and resubmitted in the `x-csrf-token` header
// (or a hidden `_csrf` form field). Same-origin policy stops a cross-site document from
// reading the cookie, so only our own pages can produce a matching pair.
//
// The cookie is deliberately NOT httpOnly — the admin JS must read it to set the header.
// That is safe here because the token authorises nothing on its own; it only proves the
// request came from a document on this origin.

export const CSRF_COOKIE_NAME = '__Host-csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';
export const CSRF_FIELD_NAME = '_csrf';

/**
 * The token a request carries in the `x-csrf-token` header, or null: an empty header is no
 * token, so the check falls back to the form field. The one answer to "does this request
 * carry a token header", for every code that asks it: the middleware's token reader and the
 * bound it puts on the body that reader reads (src/middleware.ts), and the sign-in forms'
 * refusal (src/lib/auth/expiredForm.ts). Two answers let an empty header skip the bound
 * while the reader, finding no token in it, read the whole body for its field (F7 review).
 */
export function csrfHeaderToken(request: Request): string | null {
  return request.headers.get(CSRF_HEADER_NAME) || null;
}

/** 256-bit URL-safe token. */
export function generateCsrfToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * Length-independent constant-time comparison. Token comparison with `===` leaks the
 * length of the shared prefix through timing; that is a weak oracle over a 256-bit
 * value, but it is free to remove and this is the code path an attacker gets to
 * retry without limit.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** True when the submitted token matches the cookie and both are present. */
export function csrfTokenMatches(cookieToken: string | null, submitted: string | null): boolean {
  if (!cookieToken || !submitted) return false;
  return timingSafeEqual(cookieToken, submitted);
}
