import { describe, expect, it } from 'vitest';
import {
  GA4_CSP_SOURCES,
  applySecurityHeaders,
  buildCsp,
  ensureSecurityHeaders,
} from '@/lib/http/securityHeaders';

// Google Analytics 4's hosts in the page policy (Admin v2 U15): exactly the list gtag.js
// needs without Google's Ads features, in script-src, connect-src and img-src, and ONLY when
// a response asks for them (a public page that carries the loader). Without the flag the
// policy is the one it was, byte for byte; a preview's exact connect-src never gains them;
// the Worker's backstop never adds them.

const NONCE = 'TESTNONCE0000000000000==';

/** The policy as directive → sources. */
const directives = (csp: string) =>
  new Map(
    csp.split(';').map((part) => {
      const [name = '', ...sources] = part.trim().split(/\s+/);
      return [name, sources] as const;
    }),
  );

const TODAY =
  "default-src 'self'; base-uri 'self'; object-src 'none'; " +
  `script-src 'self' 'nonce-${NONCE}'; style-src 'self' 'nonce-${NONCE}'; ` +
  "img-src 'self' https://imagedelivery.net https://*.cloudflarestream.com; font-src 'self'; " +
  "connect-src 'self'; " +
  'frame-src https://*.cloudflarestream.com https://iframe.videodelivery.net https://www.youtube-nocookie.com https://player.vimeo.com; ' +
  "media-src 'self' https://*.cloudflarestream.com https://iframe.videodelivery.net; " +
  "form-action 'self'; frame-ancestors 'self'; manifest-src 'self'; worker-src 'self' blob:; " +
  'upgrade-insecure-requests';

describe('GA4_CSP_SOURCES', () => {
  it('are the hosts gtag.js needs without the Ads features, and nothing wider', () => {
    expect(GA4_CSP_SOURCES).toEqual({
      script: ['https://www.googletagmanager.com'],
      connect: [
        'https://www.googletagmanager.com',
        'https://*.google-analytics.com',
        'https://*.analytics.google.com',
      ],
      img: ['https://www.googletagmanager.com', 'https://*.google-analytics.com'],
    });
    const all = [...GA4_CSP_SOURCES.script, ...GA4_CSP_SOURCES.connect, ...GA4_CSP_SOURCES.img];
    for (const source of all) {
      expect(source, source).toMatch(/^https:\/\/(\*\.)?[a-z0-9.-]+\.com$/);
      // Never the Ads hosts, never all of google.com, never a keyword.
      expect(source).not.toMatch(/doubleclick|googlesyndication|^https:\/\/\*\.google\.com$|'/);
    }
    expect(Object.isFrozen(GA4_CSP_SOURCES) && Object.isFrozen(GA4_CSP_SOURCES.connect)).toBe(true);
  });
});

describe('buildCsp with and without GA4', () => {
  it('without the flag, the policy is the one it was, to the byte', () => {
    expect(buildCsp(NONCE)).toBe(TODAY);
    expect(buildCsp(NONCE, { ga4: false })).toBe(TODAY);
    expect(buildCsp(NONCE)).not.toMatch(/google/);
  });

  it('with the flag, the three directives gain exactly the GA4 sources; nothing else moves', () => {
    const before = directives(buildCsp(NONCE));
    const after = directives(buildCsp(NONCE, { ga4: true }));
    expect([...after.keys()]).toEqual([...before.keys()]);
    for (const [name, sources] of after) {
      const extra =
        name === 'script-src'
          ? GA4_CSP_SOURCES.script
          : name === 'connect-src'
            ? GA4_CSP_SOURCES.connect
            : name === 'img-src'
              ? GA4_CSP_SOURCES.img
              : [];
      expect(sources, name).toEqual([...before.get(name)!, ...extra]);
    }
    expect(buildCsp(NONCE, { ga4: true })).not.toContain('unsafe-inline');
    expect(buildCsp(NONCE, { ga4: true })).not.toContain("'strict-dynamic'");
  });

  it('beside a preview’s exact connect-src, never (a preview never loads GA4)', () => {
    const csp = buildCsp(NONCE, { ga4: true, connectOnly: ['http://localhost:8788/api/x'] });
    expect(csp).not.toMatch(/google/);
  });

  it('the hashes Astro hands over still come first after the nonce', () => {
    const csp = buildCsp(NONCE, { ga4: true, scriptHashes: ["'sha256-abc='"] });
    expect(directives(csp).get('script-src')).toEqual([
      "'self'",
      `'nonce-${NONCE}'`,
      "'sha256-abc='",
      'https://www.googletagmanager.com',
    ]);
  });
});

describe('the response layers', () => {
  it('applySecurityHeaders adds them only when asked', () => {
    const asked = new Headers();
    applySecurityHeaders(asked, { nonce: NONCE, ga4: true });
    expect(asked.get('content-security-policy')).toContain('https://www.googletagmanager.com');
    const plain = new Headers();
    applySecurityHeaders(plain, { nonce: NONCE });
    expect(plain.get('content-security-policy')).not.toMatch(/google/);
  });

  it('the Worker backstop never adds them', () => {
    const out = ensureSecurityHeaders(
      new Response('x', { headers: { 'content-type': 'text/html' } }),
    );
    expect(out.headers.get('content-security-policy')).not.toMatch(/google/);
  });
});
