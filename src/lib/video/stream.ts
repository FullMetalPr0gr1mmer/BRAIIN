// Cloudflare Stream URL helpers (public, non-secret). The customer subdomain is
// account-specific — set it at provisioning (KAN-20). We use the iframe-EMBED player
// (allow-listed in CSP `frame-src`), NOT hls.js, so `connect-src` stays `'self'` and
// no third-party bytes load until the user clicks the poster facade.
const CUSTOMER_SUBDOMAIN = 'customer-PLACEHOLDER'; // TODO(KAN-20): real customer-<code>

export function streamConfigured(): boolean {
  return CUSTOMER_SUBDOMAIN !== 'customer-PLACEHOLDER';
}

/** Poster thumbnail — this is the hero LCP image. */
export function streamPoster(uid: string): string {
  return `https://${CUSTOMER_SUBDOMAIN}.cloudflarestream.com/${uid}/thumbnails/thumbnail.jpg?time=1s&height=720`;
}

/** Iframe embed URL, injected on click (frame-src allow-listed). */
export function streamIframe(uid: string): string {
  return `https://${CUSTOMER_SUBDOMAIN}.cloudflarestream.com/${uid}/iframe`;
}
