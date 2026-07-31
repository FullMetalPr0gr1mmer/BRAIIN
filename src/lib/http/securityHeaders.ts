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

/** Both spellings, because a stale header of either name would be intersected by the browser. */
const CSP_HEADER_NAMES = ['Content-Security-Policy', 'Content-Security-Policy-Report-Only'] as const;

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
  for (const name of CSP_HEADER_NAMES) {
    const existing = headers.get(name);
    if (existing === null) continue;
    scriptHashes.push(...extractHashes(existing, 'script-src'));
    styleHashes.push(...extractHashes(existing, 'style-src'));
    headers.delete(name);
  }

  const headerName = opts.reportOnly
    ? 'Content-Security-Policy-Report-Only'
    : 'Content-Security-Policy';
  headers.set(
    headerName,
    buildCsp(opts.nonce, {
      scriptHashes: [...new Set(scriptHashes)],
      styleHashes: [...new Set(styleHashes)],
    }),
  );
  headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), browsing-topics=()');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  headers.set('X-Frame-Options', 'SAMEORIGIN');
}
