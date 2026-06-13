// Strict security headers + per-request-nonce CSP (CLAUDE.md Pillar 1 / §7).
// NO 'unsafe-inline'. style-src is nonce-based (theme = CSS custom properties;
// Tiptap is class-based with inline `style=` stripped by the sanitizer). data:/blob:
// are NOT allowed in img-src. frame-ancestors 'self'.

export interface CspOptions {
  nonce: string;
  reportOnly?: boolean;
}

/** 128-bit base64 nonce, regenerated per request. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function buildCsp(nonce: string): string {
  const stream = 'https://*.cloudflarestream.com https://iframe.videodelivery.net';
  const videoFallback = 'https://www.youtube-nocookie.com https://player.vimeo.com';
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
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
  const headerName = opts.reportOnly
    ? 'Content-Security-Policy-Report-Only'
    : 'Content-Security-Policy';
  headers.set(headerName, buildCsp(opts.nonce));
  headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), browsing-topics=()');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  headers.set('X-Frame-Options', 'SAMEORIGIN');
}
