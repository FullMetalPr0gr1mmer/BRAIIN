// Strict security headers + per-request-nonce CSP (CLAUDE.md Pillar 1 / §7).
// NO 'unsafe-inline'. style-src is nonce-based (theme = CSS custom properties;
// Tiptap is class-based with inline `style=` stripped by the sanitizer). data:/blob:
// are NOT allowed in img-src. frame-ancestors 'self'.
//
// MERGE, don't clobber. Astro writes its own inline <script>/<style> for every hydrated
// island — the island styles, the `client:*` directive script, the `astro-island`
// custom-element definition, and the framework hydration script — and it does not put
// our nonce on any of them. `security.csp` in astro.config.mjs makes Astro hash them and
// ship those hashes as a CSP response header. This module used to `headers.set()` over
// that header, which deleted the hashes: the browser then blocked the astro-island
// definition and every admin island rendered server-side and stayed inert. So we now
// lift Astro's hashes off the response and fold them into our policy, emitting ONE
// header of the form `script-src 'self' 'nonce-…' 'sha256-…'`.
//
// A nonce and a hash are alternative allow-conditions for the same source list, so the
// two mechanisms coexist without weakening either: the nonce covers OUR inline blocks
// (the maintenance 503 page), the hashes cover Astro's. Neither admits 'unsafe-inline'.
//
// WHO APPLIES IT. src/middleware.ts is the primary enforcement point: every response it
// produces leaves through `withSecurityHeaders`. Two kinds of response never pass through
// it, and each has its own layer (CLAUDE.md §2, amendment 2026-10):
//   - what Astro answers BEFORE the middleware runs (the origin-check 403, the over-encoded
//     path 400, the duplicate-slash 301, a bare 500) and what the adapter passes straight
//     from the ASSETS binding — src/worker.ts wraps every response in
//     `ensureSecurityHeaders`, which secures whatever arrives without them;
//   - static files the asset worker serves without running the Worker at all —
//     public/_headers carries STATIC_SECURITY_HEADERS + ASSET_CSP for those
//     (tests/lib/headersFile.spec.ts holds the file equal to the constants below).

/**
 * CSP rollout: ship Report-Only for one cycle to collect violations, then flip to enforce.
 * THE switch — the middleware, the Worker backstop and the media route all read it. It
 * ALWAYS ships without 'unsafe-inline', in either mode.
 */
export const CSP_REPORT_ONLY = false;

/** The seven non-CSP headers on every response — pages, the Worker's own answers and static files. */
export const STATIC_SECURITY_HEADERS = Object.freeze({
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
});

/**
 * The policy for static files (public/_headers). A stylesheet, font, image or script file is
 * never a document that should run or load anything, so it allows nothing — opened directly
 * in a tab it still cannot be framed by another site, re-based or made to submit a form.
 * A page's policy (nonce + hashes) cannot apply here: these responses are built by the asset
 * worker from a static file, with no per-request nonce to give them.
 */
export const ASSET_CSP =
  "default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";

/** Both spellings, because a stale header of either name would be intersected by the browser. */
const CSP_HEADER_NAMES = [
  'Content-Security-Policy',
  'Content-Security-Policy-Report-Only',
] as const;

/** `'sha256-…'` / `'sha384-…'` / `'sha512-…'`, base64 with optional padding. */
const HASH_SOURCE = /^'(?:sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2}'$/;

export interface CspOptions {
  nonce: string;
  reportOnly?: boolean;
  /**
   * Additional hashes to admit, on top of any lifted off Astro's own header. Used by the
   * dev-only path in `src/middleware.ts` — see `collectInlineHashes`.
   */
  scriptHashes?: readonly string[];
  styleHashes?: readonly string[];
}

interface CspExtras {
  scriptHashes?: readonly string[];
  styleHashes?: readonly string[];
}

/** Inline `<script>` — negative lookahead excludes anything with a `src=`, which `'self'` already covers. */
const INLINE_SCRIPT_RE = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
const INLINE_STYLE_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let bin = '';
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Hash every inline <script>/<style> in an HTML document.
 *
 * DEV ONLY. Astro computes these during `astro build` and ships them in the manifest;
 * its dev server has no CSP code path whatsoever (there is not one reference to CSP in
 * `vite-plugin-astro-server`). Without this, dev would block Astro's island bootstrap and
 * nothing under /admin would hydrate. The obvious shortcut — relaxing the policy for dev
 * — is exactly the dev/prod divergence that let this ship undetected, so we pay the cost
 * of computing the same hashes at response time instead and keep one policy shape.
 */
export async function collectInlineHashes(
  html: string,
): Promise<{ scriptHashes: string[]; styleHashes: string[] }> {
  const hash = async (re: RegExp): Promise<string[]> => {
    const out = new Set<string>();
    for (const m of html.matchAll(re)) {
      const body = m[1];
      if (body === undefined || body.length === 0) continue;
      out.add(`'sha256-${await sha256Base64(body)}'`);
    }
    return [...out];
  };
  return { scriptHashes: await hash(INLINE_SCRIPT_RE), styleHashes: await hash(INLINE_STYLE_RE) };
}

/** 128-bit base64 nonce, regenerated per request. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Source list for one directive of a CSP string. Compares the FIRST token exactly so
 * `script-src` never accidentally matches `script-src-elem`.
 */
function directiveSources(csp: string, name: string): string[] {
  for (const part of csp.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    const head = tokens[0];
    if (head !== undefined && head.toLowerCase() === name) return tokens.slice(1);
  }
  return [];
}

/**
 * Pull the framework's inline-script/style hashes off a CSP header value. Hashes only —
 * we deliberately do NOT inherit keywords or host sources from Astro's header, so a
 * future Astro default cannot widen our policy behind our back.
 */
export function extractHashes(csp: string | null | undefined, directive: string): string[] {
  if (!csp) return [];
  const found = new Set<string>();
  for (const source of directiveSources(csp, directive)) {
    if (HASH_SOURCE.test(source)) found.add(source);
  }
  return [...found];
}

/** True when a CSP header value carries the `sandbox` directive (with or without flags). */
export function hasSandbox(csp: string): boolean {
  return csp.split(';').some((d) => /^sandbox(\s|$)/i.test(d.trim()));
}

export function buildCsp(nonce: string, extras?: CspExtras): string {
  const stream = 'https://*.cloudflarestream.com https://iframe.videodelivery.net';
  const videoFallback = 'https://www.youtube-nocookie.com https://player.vimeo.com';
  const scriptSrc = ["'self'", `'nonce-${nonce}'`, ...(extras?.scriptHashes ?? [])].join(' ');
  const styleSrc = ["'self'", `'nonce-${nonce}'`, ...(extras?.styleHashes ?? [])].join(' ');
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    "img-src 'self' https://imagedelivery.net https://*.cloudflarestream.com",
    "font-src 'self'",
    "connect-src 'self'", // same-origin RUM beacon + Sentry tunnel
    `frame-src ${stream} ${videoFallback}`,
    `media-src 'self' ${stream}`,
    "form-action 'self'",
    "frame-ancestors 'self'",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
    'upgrade-insecure-requests',
  ].join('; ');
}

export function applySecurityHeaders(headers: Headers, opts: CspOptions): void {
  // Lift Astro's island hashes, then DELETE both header spellings. Deleting matters as
  // much as reading: two CSP headers are intersected by the browser, so an enforcing
  // header left behind by Astro would keep blocking even while we ship Report-Only.
  const scriptHashes: string[] = [...(opts.scriptHashes ?? [])];
  const styleHashes: string[] = [...(opts.styleHashes ?? [])];
  let sandboxed = false;
  for (const name of CSP_HEADER_NAMES) {
    const existing = headers.get(name);
    if (existing === null) continue;
    scriptHashes.push(...extractHashes(existing, 'script-src'));
    styleHashes.push(...extractHashes(existing, 'style-src'));
    sandboxed ||= hasSandbox(existing);
    headers.delete(name);
  }

  const headerName = opts.reportOnly
    ? 'Content-Security-Policy-Report-Only'
    : 'Content-Security-Policy';
  const csp = buildCsp(opts.nonce, {
    scriptHashes: [...new Set(scriptHashes)],
    styleHashes: [...new Set(styleHashes)],
  });
  // A response that asked for `sandbox` keeps it (the admin's CV download, Join): the rebuild
  // below may only ever ADD restrictions to what a route set, never drop one. Hashes and
  // `sandbox` are the only parts of a route's CSP that survive — no route can widen ours.
  headers.set(headerName, sandboxed ? `${csp}; sandbox` : csp);
  // Browsers ignore `sandbox` in a Report-Only policy, so in that mode a sandboxed response
  // also carries an ENFORCED one holding just the sandbox.
  if (sandboxed && opts.reportOnly) headers.set('Content-Security-Policy', 'sandbox');
  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) headers.set(name, value);
}

/**
 * Apply the security headers to a response, tolerating IMMUTABLE headers. A Response
 * that came out of `fetch()` or a platform asset/image service carries the "immutable"
 * headers guard — every mutation throws. The `/_image` endpoint (astro:assets → Images
 * binding / dev sharp) was the first public route to return one, and the middleware
 * turned each of its responses into a 500. Rebuilding via `new Response(body, response)`
 * yields a byte-identical response with a mutable header map; the rebuild happens only
 * on the throwing path, so normal renders pay nothing.
 *
 * (The first mutation `applySecurityHeaders` attempts throws before anything is
 * written, so the retry never double-applies.)
 */
export function withSecurityHeaders(response: Response, opts: CspOptions): Response {
  try {
    applySecurityHeaders(response.headers, opts);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    applySecurityHeaders(copy.headers, opts);
    return copy;
  }
}

/**
 * The Worker's backstop (src/worker.ts): secure a response that left WITHOUT the headers,
 * and leave every other one exactly as it is.
 *
 * Keyed on HSTS, never on CSP. Only `applySecurityHeaders` and public/_headers set HSTS, so
 * its presence means one of the two layers already ran: the middleware's page (its nonce
 * matches the page's nonced blocks, and it may be Report-Only — overwriting that with an
 * enforcing policy carrying a nonce the page lacks would break it), or a static file with
 * ASSET_CSP. Keying on CSP instead would also take Astro's own `security.csp` header — which
 * a response escaping the middleware can carry — for a finished policy.
 *
 * A WebSocket upgrade (101, or a response carrying `webSocket`) goes through untouched: its
 * headers belong to the handshake, and a rebuilt copy would not carry the socket. The site
 * has none today; the guard keeps the backstop from being what breaks the first one.
 */
export function ensureSecurityHeaders(
  response: Response,
  opts: { reportOnly?: boolean } = {},
): Response {
  if (response.status === 101 || (response as { webSocket?: unknown }).webSocket) return response;
  if (response.headers.has('Strict-Transport-Security')) return response;
  return withSecurityHeaders(response, {
    nonce: generateNonce(),
    reportOnly: opts.reportOnly ?? CSP_REPORT_ONLY,
  });
}
