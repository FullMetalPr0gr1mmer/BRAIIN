import { expect, test } from '@playwright/test';

/*
 * Authored redirects at the edge (Round 3, item A; design-port R3-1..R3-3).
 *
 * The admin writes `public.redirects`; every save rebuilds the tenant's map into KV
 * `site:redirects`; the middleware consults that map ONLY where the render answered 404.
 * An admin-API-driven journey is not possible in CI (no auth hook, no seeded staff user),
 * so the perf-seo-a11y workflow seeds the map straight into the local KV the preview
 * Worker reads, before `wrangler dev` starts:
 *
 *   npx wrangler kv key put site:redirects '<json>' --binding SESSION --local --preview
 *
 * (from the repo root, AFTER scripts/local-preview-config.mjs — wrangler follows the
 * build's .wrangler/deploy/config.json redirect, so the key lands in the same
 * .wrangler/state the preview reads; `--config dist/server/wrangler.json` would persist
 * under dist/server/.wrangler instead and the Worker would never see it. `--preview`
 * because the binding declares a preview_id, which is the namespace `wrangler dev` binds.)
 *
 * The seeded map is SEEDED_MAP below — the workflow's JSON must stay equal to it.
 */

export const SEEDED_MAP = {
  '/e2e-old': { to: '/about', status: 301 },
  '/e2e-temp': { to: '/contact?from=e2e', status: 302 },
  // Reserved: the map builder drops it on a real sync, and the middleware never consults
  // the map under /api anyway — seeded here to prove the second fence end to end.
  '/api/e2e-old': { to: '/about', status: 301 },
} as const;

const REDIRECT_CACHE_CONTROL = 'public, max-age=86400';
const NO_STORE = 'private, no-store';

test.describe('authored redirects reach the edge', () => {
  test('a seeded rule answers a 301 with Location and a day of cache', async ({ request }) => {
    const res = await request.get('/e2e-old', { maxRedirects: 0 });
    expect(res.status()).toBe(301);
    expect(res.headers()['location']).toBe('/about');
    expect(res.headers()['cache-control']).toBe(REDIRECT_CACHE_CONTROL);
    // The 30x leaves through secured(): the hop carries the security headers too.
    expect(res.headers()['strict-transport-security']).toBeTruthy();
    expect(res.headers()['content-security-policy']).toBeTruthy();
  });

  test('the trailing-slash spelling is the same rule (trailingSlash: ignore)', async ({
    request,
  }) => {
    const res = await request.get('/e2e-old/', { maxRedirects: 0 });
    expect(res.status()).toBe(301);
    expect(res.headers()['location']).toBe('/about');
  });

  test('the request query is carried when the target has none', async ({ request }) => {
    const res = await request.get('/e2e-old?x=1&utm_source=e2e', { maxRedirects: 0 });
    expect(res.status()).toBe(301);
    expect(res.headers()['location']).toBe('/about?x=1&utm_source=e2e');
  });

  test('a target with its own query wins, and the rule’s status is kept (302)', async ({
    request,
  }) => {
    const res = await request.get('/e2e-temp?x=1', { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    expect(res.headers()['location']).toBe('/contact?from=e2e');
  });

  test('the /ar twin of an English rule redirects to the Arabic target (R3-2)', async ({
    request,
  }) => {
    const res = await request.get('/ar/e2e-old', { maxRedirects: 0 });
    expect(res.status()).toBe(301);
    expect(res.headers()['location']).toBe('/ar/about');
    expect(res.headers()['cache-control']).toBe(REDIRECT_CACHE_CONTROL);
  });

  test('/api/* is never redirected, even with a rule in the map', async ({ request }) => {
    const res = await request.get('/api/e2e-old', { maxRedirects: 0 });
    expect(res.status()).toBe(404);
  });

  test('/healthz is never redirectable and answers 200', async ({ request }) => {
    expect((await request.get('/healthz')).status()).toBe(200);
  });

  test('a live page is never shadowed by the map — the rule applies only after a 404', async ({
    request,
  }) => {
    // /about is the TARGET of a seeded rule and a real page; the lookup is 404-first, so a
    // page that renders is served whatever the map says.
    for (const path of ['/about', '/ar/about', '/contact']) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(200);
    }
  });

  test('a 404 with no rule stays a 404 and is never edge-cached (the safeguard)', async ({
    request,
  }) => {
    for (const path of ['/e2e-no-such-page', '/ar/e2e-no-such-page']) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(404);
      // A cached 404 would shadow a rule authored later for that URL (design-port R3-1).
      expect(res.headers()['cache-control'], path).toBe(NO_STORE);
    }
  });

  test('the route-level code map still wins for a retired service slug', async ({ request }) => {
    const res = await request.get('/services/branding', { maxRedirects: 0 });
    expect(res.status()).toBe(301);
    expect(res.headers()['location']).toBe('/services#branding');
    // Both kinds of 30x carry the same lifetime (REDIRECT_CACHE_CONTROL, shared).
    expect(res.headers()['cache-control']).toBe(REDIRECT_CACHE_CONTROL);
  });

  test('a POST to a redirected path is not redirected', async ({ request }) => {
    const res = await request.post('/e2e-old', { maxRedirects: 0, data: {} });
    expect(res.status()).not.toBe(301);
    expect(res.headers()['location']).toBeUndefined();
  });
});
