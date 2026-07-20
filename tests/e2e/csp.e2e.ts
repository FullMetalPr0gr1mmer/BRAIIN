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

const ROUTES = ['/', '/ar', '/contact', '/search', '/services', '/creative-knowledge'];

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

    await page.goto(route, { waitUntil: 'networkidle' });

    const inPage = await page.evaluate(
      () => (window as unknown as { __cspViolations: string[] }).__cspViolations ?? [],
    );
    expect([...violations, ...inPage], `CSP violations on ${route}`).toEqual([]);
  });
}

test('every component script is external (no nonce-less inline module)', async ({ page }) => {
  await page.goto('/contact', { waitUntil: 'networkidle' });
  // A module script with neither `src` nor a nonce would be blocked by our CSP.
  const bad = await page.$$eval(
    'script[type="module"]',
    (nodes) => nodes.filter((n) => !n.getAttribute('src') && !n.getAttribute('nonce')).length,
  );
  expect(bad, 'inline module scripts without a nonce').toBe(0);
});
