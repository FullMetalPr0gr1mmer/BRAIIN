import { test, expect } from '@playwright/test';

// CSP regression guard (CLAUDE.md Pillar 1). Our policy is `script-src 'self' 'nonce-…'`
// with NO 'unsafe-inline'. Astro's renderScript will inline component <script> chunks that
// fall under `assetsInlineLimit` as a bare `<script type="module">` with no nonce — the
// browser then silently refuses to execute them, killing the consent banner (PDPL gate),
// contact form, search, error reporter and the Stream facade. That failure is invisible to
// build, typecheck, size-limit and any JS-disabled check: it is a browser console event.
//
// `vite.build.assetsInlineLimit: 0` (astro.config.mjs) is what prevents it. These tests
// make that guarantee enforceable instead of human-only.

// `/admin/login` is in the list because Phase 3 introduced the first HYDRATED React on
// this site, and hydration is exactly where a nonce-less inline script would appear.
// It is the only admin route reachable without a session. Every signed-in admin screen
// gets the same checks, per role, in the admin sweep (tests/admin/sweep.e2e.ts).
const ROUTES = [
  '/',
  '/ar',
  '/contact',
  '/ar/contact',
  '/search',
  '/services',
  // Round 2 (S3): the explorer and APG tabs are module scripts
  '/ar/services',
  '/creative-knowledge',
  // UI v2 PR10 — Our Work and All projects (the catalogue enhancement is a module script)
  '/portfolio',
  '/ar/portfolio',
  '/portfolio/all',
  '/ar/portfolio/all',
  // UI v2 PR11 — the case study (the lightbox, banner and clip enhancements are module scripts)
  '/portfolio/the-rider',
  '/ar/portfolio/the-rider',
  // Round 2 (S4) — a service page (the floating button and the form are module scripts)
  '/services/logo',
  '/ar/services/logo',
  '/admin/login',
  '/about',
  '/ar/about',
  // Join — the application form and its dropzone are module scripts
  '/join',
  '/ar/join',
];

for (const route of ROUTES) {
  test(`CSP: no securitypolicyviolation on ${route}`, async ({ page }) => {
    const violations: string[] = [];

    // Fires in-page for every blocked resource/inline script.
    await page.addInitScript(() => {
      (window as unknown as { __cspViolations: string[] }).__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        (window as unknown as { __cspViolations: string[] }).__cspViolations.push(
          `${e.violatedDirective} :: ${e.blockedURI || 'inline'}`,
        );
      });
    });
    // Console-level backstop ("Refused to execute inline script…").
    page.on('console', (msg) => {
      const t = msg.text();
      if (/Content Security Policy|Refused to (execute|load|apply)/i.test(t)) violations.push(t);
    });

    // `load` plus a settle window, not `networkidle`: with byte ranges (/media is served
    // through the Worker) Chromium buffers a playing <video> ahead and then PARKS the open
    // request, which Playwright counts as in flight — so a page with a banner loop never
    // goes network-idle. Late violations still land inside the settle window.
    await page.goto(route, { waitUntil: 'load' });
    await page.waitForTimeout(2000);

    const inPage = await page.evaluate(
      () => (window as unknown as { __cspViolations: string[] }).__cspViolations ?? [],
    );
    expect([...violations, ...inPage], `CSP violations on ${route}`).toEqual([]);
  });
}

for (const route of [
  '/contact',
  '/ar/contact',
  '/admin/login',
  '/about',
  '/portfolio/all',
  '/portfolio/the-rider',
  '/services/logo',
  '/services',
  '/join',
]) {
  test(`every component script is external on ${route}`, async ({ page }) => {
    // `load`, not `networkidle` — a playing banner video never goes idle (see above).
    await page.goto(route, { waitUntil: 'load' });
    // A module script with neither `src` nor a nonce would be blocked by our CSP.
    const bad = await page.$$eval(
      'script[type="module"]',
      (nodes) => nodes.filter((n) => !n.getAttribute('src') && !n.getAttribute('nonce')).length,
    );
    expect(bad, 'inline module scripts without a nonce').toBe(0);
  });
}

test('admin pages carry no inline style attributes', async ({ page }) => {
  // `style-src` has no 'unsafe-inline', so a `style="…"` attribute is dead markup: it is
  // silently ignored and the element renders unstyled. React's `style={{…}}` prop emits
  // exactly that during Astro's server render, which is why the admin uses `data-*`
  // buckets and utility classes instead. This is the check that keeps it that way.
  //
  // It reads the SERVER HTML (parsed, never run), not the live DOM: a style a script sets
  // through the CSSOM after hydration is allowed by the policy, and blaming it would push
  // a screen towards the markup styles that are not.
  const html = await (await page.request.get('/admin/login')).text();
  const inlineStyled = await page.evaluate(
    (markup) =>
      new DOMParser().parseFromString(markup, 'text/html').querySelectorAll('[style]').length,
    html,
  );
  expect(inlineStyled, 'elements carrying a blocked inline style attribute').toBe(0);
});

test('admin is non-indexable and never cached', async ({ page }) => {
  const response = await page.goto('/admin/login');
  expect(response?.headers()['cache-control']).toContain('no-store');
  const robots = await page.getAttribute('meta[name="robots"]', 'content');
  expect(robots).toContain('noindex');
});

test('an unauthenticated admin route redirects to login', async ({ page }) => {
  await page.goto('/admin/services');
  expect(new URL(page.url()).pathname).toBe('/admin/login');
});
