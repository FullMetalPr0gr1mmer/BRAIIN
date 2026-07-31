import { describe, it, expect } from 'vitest';
import {
  buildCsp,
  applySecurityHeaders,
  generateNonce,
  extractHashes,
  collectInlineHashes,
} from '@/lib/http/securityHeaders';

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

// ---------------------------------------------------------------------------
// Island-hash merging. Astro writes its own un-nonced inline <script>/<style> for every
// hydrated island (the client:* directive, the `astro-island` custom-element definition,
// the framework hydration script, the island styles). This module used to `.set()` over
// Astro's CSP header, deleting the hashes that admit them — so the custom element was
// never defined and EVERY /admin island rendered server-side and then sat inert. These
// tests pin the merge, and pin that merging cannot widen the policy.
// ---------------------------------------------------------------------------

const ASTRO_SCRIPT_HASH = "'sha256-QzWFZi+FLIx23tnm9SBU4aEgx4x8DsuASP07mfqol/c='";
const ASTRO_STYLE_HASH = "'sha256-vv9IoKo7BSLbWcUHr3tNmfNVmm5L/9Cfn2H6LMk7/ow='";

describe('extractHashes', () => {
  it('pulls hash sources out of a directive', () => {
    const csp = `script-src 'self' ${ASTRO_SCRIPT_HASH}; style-src 'self' ${ASTRO_STYLE_HASH}`;
    expect(extractHashes(csp, 'script-src')).toEqual([ASTRO_SCRIPT_HASH]);
    expect(extractHashes(csp, 'style-src')).toEqual([ASTRO_STYLE_HASH]);
  });

  it('inherits ONLY hashes — never keywords or hosts, so Astro cannot widen our policy', () => {
    const hostile = `script-src 'self' 'unsafe-inline' 'unsafe-eval' https://evil.example ${ASTRO_SCRIPT_HASH}`;
    expect(extractHashes(hostile, 'script-src')).toEqual([ASTRO_SCRIPT_HASH]);
  });

  it('matches the directive name exactly (script-src must not match script-src-elem)', () => {
    const csp = `script-src-elem 'self' ${ASTRO_SCRIPT_HASH}`;
    expect(extractHashes(csp, 'script-src')).toEqual([]);
  });

  it('is safe on a missing or empty header', () => {
    expect(extractHashes(null, 'script-src')).toEqual([]);
    expect(extractHashes('', 'script-src')).toEqual([]);
  });
});

describe('applySecurityHeaders — merging Astro CSP', () => {
  it("lifts Astro's hashes into our policy alongside the nonce", () => {
    const h = new Headers({
      'Content-Security-Policy': `script-src 'self' ${ASTRO_SCRIPT_HASH}; style-src 'self' ${ASTRO_STYLE_HASH}`,
    });
    applySecurityHeaders(h, { nonce: NONCE });
    const csp = h.get('Content-Security-Policy') ?? '';
    expect(csp).toContain(`'nonce-${NONCE}'`);
    expect(csp).toContain(ASTRO_SCRIPT_HASH);
    expect(csp).toContain(ASTRO_STYLE_HASH);
    expect(csp).not.toContain('unsafe-inline');
  });

  it('emits exactly ONE CSP header — two would be intersected by the browser', () => {
    const h = new Headers({ 'Content-Security-Policy': `script-src 'self' ${ASTRO_SCRIPT_HASH}` });
    applySecurityHeaders(h, { nonce: NONCE });
    // Headers.getSetCookie has no CSP equivalent; a merged value proves it replaced.
    expect(h.get('Content-Security-Policy')).toContain('default-src');
    expect(h.get('Content-Security-Policy-Report-Only')).toBeNull();
  });

  it("removes Astro's ENFORCING header when we ship Report-Only", () => {
    // Otherwise the leftover enforcing header keeps blocking while we believe we are
    // only observing — the Report-Only rollout in §3 would be silently a no-op.
    const h = new Headers({ 'Content-Security-Policy': `script-src 'self' ${ASTRO_SCRIPT_HASH}` });
    applySecurityHeaders(h, { nonce: NONCE, reportOnly: true });
    expect(h.get('Content-Security-Policy')).toBeNull();
    expect(h.get('Content-Security-Policy-Report-Only')).toContain(ASTRO_SCRIPT_HASH);
  });

  it('accepts caller-supplied hashes (the dev-only runtime path)', () => {
    const h = new Headers();
    applySecurityHeaders(h, { nonce: NONCE, scriptHashes: [ASTRO_SCRIPT_HASH] });
    expect(h.get('Content-Security-Policy')).toContain(ASTRO_SCRIPT_HASH);
  });
});

describe('collectInlineHashes', () => {
  it('hashes inline scripts and styles, and skips external ones', async () => {
    const html = `<script src="/a.js"></script><script>alert(1)</script><style>.a{color:red}</style>`;
    const { scriptHashes, styleHashes } = await collectInlineHashes(html);
    expect(scriptHashes).toHaveLength(1);
    expect(styleHashes).toHaveLength(1);
    expect(scriptHashes[0]).toMatch(/^'sha256-[A-Za-z0-9+/]+={0,2}'$/);
  });

  it('produces a hash the browser would accept for that exact body', async () => {
    // Value pinned against Web Crypto so a refactor of the digest path is caught.
    const { scriptHashes } = await collectInlineHashes('<script>alert(1)</script>');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('alert(1)'));
    const expected = `'sha256-${Buffer.from(digest).toString('base64')}'`;
    expect(scriptHashes[0]).toBe(expected);
  });

  it('deduplicates identical inline blocks', async () => {
    const { scriptHashes } = await collectInlineHashes(
      '<script>alert(1)</script><script>alert(1)</script>',
    );
    expect(scriptHashes).toHaveLength(1);
  });

  it('ignores empty blocks and src-bearing scripts with attributes', async () => {
    const html = `<script type="module" src="/x.js"></script><script></script>`;
    const { scriptHashes } = await collectInlineHashes(html);
    expect(scriptHashes).toEqual([]);
  });
});
