import { expect, test, type APIResponse } from '@playwright/test';
import { ASSET_CSP, STATIC_SECURITY_HEADERS } from '../../src/lib/http/securityHeaders';

/*
 * Every response carries the security headers (CLAUDE.md §2, amendment 2026-10) — not
 * only the ones that pass through src/middleware.ts.
 *
 * The production gap this guards (found 2026-10-03): Astro answers some requests before the
 * middleware runs — the origin check's cross-site 403, the 400 for a multiply-encoded path,
 * the 301 that collapses a duplicate slash — and the asset worker serves every static file
 * but /media/* without the Worker at all. All of them shipped with no HSTS, no nosniff and
 * no CSP. The Worker backstop (src/worker.ts → ensureSecurityHeaders) secures the first
 * kind; public/_headers the second, with the asset policy (ASSET_CSP).
 *
 * Runs against the built Worker under `wrangler dev`, whose asset worker applies
 * public/_headers as production's does.
 */

function headerValues(res: APIResponse, name: string): string[] {
  return res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === name)
    .map((h) => h.value);
}

function expectStaticHeaders(res: APIResponse, what: string) {
  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) {
    expect(headerValues(res, name.toLowerCase()), `${name} on ${what}`).toEqual([value]);
  }
}

/** A page-style policy: exactly one CSP header, one nonce value, `default-src 'self'`. */
function expectPagePolicy(res: APIResponse, what: string) {
  const csp = headerValues(res, 'content-security-policy');
  expect(csp, `one CSP header on ${what}`).toHaveLength(1);
  expect(csp[0], what).toContain("default-src 'self'");
  const nonces = new Set([...csp[0]!.matchAll(/'nonce-([^']+)'/g)].map((m) => m[1]));
  expect(nonces.size, `one nonce on ${what}`).toBe(1);
  expect(csp[0], what).not.toContain('unsafe-inline');
}

function expectAssetPolicy(res: APIResponse, what: string) {
  expect(headerValues(res, 'content-security-policy'), `ASSET_CSP on ${what}`).toEqual([ASSET_CSP]);
}

test.describe('what Astro answers before the middleware — the Worker backstop', () => {
  test('a cross-site form POST → the origin check’s 403, secured', async ({ request }) => {
    const res = await request.post('/contact', {
      headers: {
        origin: 'https://evil.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      data: 'name=x',
      maxRedirects: 0,
    });
    expect(res.status()).toBe(403);
    expect(await res.text()).toBe('Cross-site POST form submissions are forbidden');
    expectStaticHeaders(res, 'the cross-site 403');
    expectPagePolicy(res, 'the cross-site 403');
  });

  test('a multiply-encoded path → 400, secured', async ({ request }) => {
    const res = await request.get(`/%${'25'.repeat(12)}41`, { maxRedirects: 0 });
    expect(res.status()).toBe(400);
    expectStaticHeaders(res, 'the 400');
    expectPagePolicy(res, 'the 400');
  });

  test('a duplicate trailing slash → 301 to the single slash, secured', async ({ request }) => {
    const res = await request.get('/about//', { maxRedirects: 0 });
    expect(res.status()).toBe(301);
    expect(res.headers()['location']).toBe('/about/');
    expectStaticHeaders(res, 'the 301');
    expectPagePolicy(res, 'the 301');
  });

  test('a rendered page still carries the middleware’s policy alone', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);
    expectStaticHeaders(res, '/');
    expectPagePolicy(res, '/');
  });
});

test.describe('static files — public/_headers', () => {
  // The share card too: every link preview fetches it (tests/e2e/share-image.e2e.ts).
  for (const path of ['/styles/global.css', '/fonts/archivo-var-latin.woff2', '/og/default.jpg']) {
    test(`${path} carries the headers and the asset policy`, async ({ request }) => {
      const res = await request.get(path);
      expect(res.status()).toBe(200);
      expectStaticHeaders(res, path);
      expectAssetPolicy(res, path);
    });
  }

  test('an /_astro chunk keeps its immutable caching beside the headers', async ({ request }) => {
    // The adapter adds `/_astro/*` immutable caching to the built _headers only when no
    // rule already sets Cache-Control for that path — public/_headers must never set one.
    const html = await (await request.get('/')).text();
    const chunk = /src="(\/_astro\/[^"]+\.js)"/.exec(html)?.[1];
    expect(chunk, 'a module script on /').toBeTruthy();
    const res = await request.get(chunk!);
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
    expectStaticHeaders(res, chunk!);
    expectAssetPolicy(res, chunk!);
  });

  test('a /media still (through the Worker, from the ASSETS binding) is secured', async ({
    request,
  }) => {
    // `run_worker_first: ["/media/*"]` sends it to the Worker; not an .mp4, it falls through
    // to the adapter, which answers it from the ASSETS binding. The asset worker attaches
    // public/_headers to every response it builds, binding fetches included (measured under
    // `wrangler dev`; production runs the same asset-worker code) — so ASSET_CSP arrives and
    // the backstop, finding HSTS, leaves it. Were the rules ever missing, the backstop would
    // add the page policy instead and this assertion would say so.
    const res = await request.get('/media/hero-poster-blur.jpg');
    expect(res.status()).toBe(200);
    expectStaticHeaders(res, '/media/hero-poster-blur.jpg');
    expectAssetPolicy(res, '/media/hero-poster-blur.jpg');
  });
});
