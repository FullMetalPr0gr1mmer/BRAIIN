import { describe, it, expect } from 'vitest';
import { buildCsp, applySecurityHeaders, generateNonce } from '@/lib/http/securityHeaders';

// CLAUDE.md §7: "Don't call CSP 'strict' while shipping 'unsafe-inline'." This suite is
// the machine-checked version of that sentence — the CSP enforcement point had no unit
// test at all, so every property below was previously guarded by reading it carefully.

const NONCE = 'dGVzdC1ub25jZS0xMjM0';

describe('buildCsp', () => {
  const csp = buildCsp(NONCE);
  const directive = (name: string) =>
    csp
      .split('; ')
      .find((d) => d === name || d.startsWith(`${name} `))
      ?.slice(name.length)
      .trim() ?? '';

  it("NEVER contains 'unsafe-inline' or 'unsafe-eval'", () => {
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('nonces BOTH script-src and style-src (style-src is nonce-based, not unsafe-inline)', () => {
    expect(directive('script-src')).toContain(`'nonce-${NONCE}'`);
    expect(directive('style-src')).toContain(`'nonce-${NONCE}'`);
  });

  it('drops data: and blob: from img-src (§7 — the sanitizer drops them too)', () => {
    const img = directive('img-src');
    expect(img).not.toContain('data:');
    expect(img).not.toContain('blob:');
  });

  it('pins frame-ancestors, connect-src, base-uri, object-src and form-action', () => {
    expect(directive('frame-ancestors')).toBe("'self'");
    expect(directive('connect-src')).toBe("'self'"); // same-origin RUM + Sentry tunnel
    expect(directive('base-uri')).toBe("'self'");
    expect(directive('object-src')).toBe("'none'");
    expect(directive('form-action')).toBe("'self'");
  });

  it('has a default-src fallback and upgrades insecure requests', () => {
    expect(directive('default-src')).toBe("'self'");
    expect(csp).toContain('upgrade-insecure-requests');
  });

  it('allows Cloudflare Stream in frame-src/media-src only (video is Stream-only)', () => {
    expect(directive('media-src')).toContain('cloudflarestream.com');
    expect(directive('frame-src')).toContain('cloudflarestream.com');
    expect(directive('script-src')).not.toContain('cloudflarestream.com');
  });

  it('embeds the caller-supplied nonce verbatim', () => {
    expect(buildCsp('AAAA1111')).toContain("'nonce-AAAA1111'");
  });
});

describe('generateNonce', () => {
  it('is base64 and long enough to be unguessable (128-bit)', () => {
    const n = generateNonce();
    expect(n).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(atob(n)).toHaveLength(16);
  });

  it('is unique per call — a reused nonce is no nonce', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateNonce()));
    expect(seen.size).toBe(200);
  });

  it('never contains a double quote (it is interpolated into an HTML attribute)', () => {
    for (let i = 0; i < 100; i++) expect(generateNonce()).not.toContain('"');
  });
});

describe('applySecurityHeaders', () => {
  const apply = (opts?: { reportOnly?: boolean }) => {
    const h = new Headers();
    applySecurityHeaders(h, { nonce: NONCE, ...(opts ?? {}) });
    return h;
  };

  it('sets the enforcing CSP header by default', () => {
    const h = apply();
    expect(h.get('Content-Security-Policy')).toContain("'nonce-");
    expect(h.get('Content-Security-Policy-Report-Only')).toBeNull();
  });

  it('switches to Report-Only when asked — and still ships no unsafe-inline', () => {
    const h = apply({ reportOnly: true });
    expect(h.get('Content-Security-Policy')).toBeNull();
    const ro = h.get('Content-Security-Policy-Report-Only');
    expect(ro).toContain("'nonce-");
    expect(ro).not.toContain('unsafe-inline');
  });

  it('sets HSTS with preload + a 2-year max-age', () => {
    const hsts = apply().get('Strict-Transport-Security');
    expect(hsts).toContain('preload');
    expect(hsts).toContain('includeSubDomains');
    expect(Number(/max-age=(\d+)/.exec(hsts ?? '')?.[1])).toBeGreaterThanOrEqual(31536000);
  });

  it('sets the remaining §7 headers', () => {
    const h = apply();
    expect(h.get('X-Content-Type-Options')).toBe('nosniff');
    expect(h.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(h.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(h.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect(h.get('Permissions-Policy')).toContain('camera=()');
    expect(h.get('X-Frame-Options')).toBe('SAMEORIGIN');
  });

  it('overwrites a pre-set weaker header rather than appending a second one', () => {
    const h = new Headers({ 'X-Frame-Options': 'ALLOWALL' });
    applySecurityHeaders(h, { nonce: NONCE });
    expect(h.get('X-Frame-Options')).toBe('SAMEORIGIN');
  });

  it('applies cleanly to a redirect and to a 503 — not just to rendered pages', () => {
    // Regression guard: the middleware used to `return` on the maintenance and redirect
    // branches BEFORE reaching applySecurityHeaders, so both left with no CSP, no HSTS
    // and no nosniff. These responses must be securable like any other.
    for (const res of [
      new Response(null, { status: 301, headers: { Location: '/new' } }),
      new Response('maintenance', { status: 503 }),
    ]) {
      applySecurityHeaders(res.headers, { nonce: NONCE });
      expect(res.headers.get('Content-Security-Policy')).toContain("'nonce-");
      expect(res.headers.get('Strict-Transport-Security')).toContain('preload');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    }
  });
});
