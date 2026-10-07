import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { SKIP_REASON, STAFF_ROLES, authFile, staffEnv } from './staff';
import { UNSEEDED_LISTS, expectedSidebar, sweepRoutes, type SweepRoute } from './routes';

/*
 * The per-role admin sweep (Admin v2 F0): the client's adfull.mjs acceptance run on the
 * real CMS. Every screen a role's sidebar offers, plus its create and edit screens, is
 * opened once per role, signed in as that role (staff.setup.ts).
 *
 * One visit checks everything, each check soft so the first failure does not hide the
 * rest:
 *   server  200 for the signed-in role, a CSP carrying a nonce and no 'unsafe-inline',
 *           no-store, noindex, and no `style=` attribute in the SERVER HTML, parsed but
 *           never run. style-src has no 'unsafe-inline', so a markup style is dead, while
 *           a style a script sets later through the CSSOM is allowed: reading the live DOM
 *           would blame the second and could miss nothing the first catches.
 *   live    no page error, no console error (a failed API call logs one), no CSP
 *           violation, no error message on the screen, no horizontal overflow (the
 *           client's scrollWidth <= clientWidth + 2), and the sidebar the server derives
 *           for the role.
 *   axe     zero WCAG 2.2 A/AA violations, as on the public routes (CLAUDE.md §9). The
 *           first run found none on any admin screen, so there is no baseline to carry.
 *
 * Its first CI run found two live defects, both fixed in F0: every rich-text editor
 * injected a runtime <style> that style-src refused (Tiptap's injectCSS), and the header
 * search could not search two bilingual tables (ilike on a jsonb column).
 */

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** Tolerance of the overflow check, as in the client's sweep. */
const OVERFLOW_PX = 2;

test.skip(!staffEnv(), SKIP_REASON);
// Every element in its final state, as the public axe suite does (tests/a11y/axe.e2e.ts).
test.use({ contextOptions: { reducedMotion: 'reduce' } });

/**
 * The URL to open: an edit screen takes the first row its role's own list API returns.
 * Null only for a list the seed leaves empty (UNSEEDED_LISTS). A refused or failing list,
 * or an empty one the seed fills, fails the test: the role's menu offers that screen.
 */
async function resolvePath(page: Page, route: SweepRoute): Promise<string | null> {
  if (route.kind !== 'edit') return route.path;
  const listApi = route.listApi ?? '';
  const res = await page.request.get(`${listApi}?limit=1`);
  expect(res.status(), `${listApi} answers the signed-in role`).toBe(200);
  const body = (await res.json()) as { data?: { rows?: { id?: unknown }[] } };
  const id = body.data?.rows?.[0]?.id;
  if (typeof id === 'string') return route.path.replace('[id]', id);
  expect(
    UNSEEDED_LISTS[listApi],
    `${listApi} answered no row, but the seed has rows for it`,
  ).toBeDefined();
  return null;
}

for (const role of STAFF_ROLES) {
  test.describe(`as ${role}`, () => {
    test.use({ storageState: authFile(role) });

    for (const route of sweepRoutes(role)) {
      test(route.kind === 'edit' ? route.pattern : route.path, async ({ page }) => {
        const path = await resolvePath(page, route);
        if (path === null) {
          test.skip(
            true,
            `the seed has no ${UNSEEDED_LISTS[route.listApi ?? '']} row: no edit screen to open`,
          );
          return;
        }

        // ---- server HTML ------------------------------------------------------------
        const res = await page.request.get(path, { maxRedirects: 0 });
        expect(res.status(), `${path} answers the signed-in ${role}`).toBe(200);
        const headers = res.headers();
        const csp = headers['content-security-policy'] ?? '';
        expect.soft(csp, 'CSP: script-src carries a nonce').toMatch(/script-src[^;]*'nonce-/);
        expect.soft(csp, 'CSP: style-src carries a nonce').toMatch(/style-src[^;]*'nonce-/);
        expect.soft(csp, "CSP: no 'unsafe-inline'").not.toContain("'unsafe-inline'");
        expect.soft(headers['cache-control'] ?? '', 'Cache-Control').toContain('no-store');

        const server = await page.evaluate(
          (markup) => {
            const doc = new DOMParser().parseFromString(markup, 'text/html');
            return {
              styled: [...doc.querySelectorAll('[style]')].map((el) => el.outerHTML.slice(0, 160)),
              unNoncedModules: doc.querySelectorAll('script[type="module"]:not([src]):not([nonce])')
                .length,
              robots: doc.querySelector('meta[name="robots"]')?.getAttribute('content') ?? '',
            };
          },
          await res.text(),
        );
        expect.soft(server.styled, 'style= attributes in the server HTML').toEqual([]);
        expect.soft(server.unNoncedModules, 'inline module scripts without a nonce').toBe(0);
        expect.soft(server.robots, 'meta robots').toContain('noindex');

        // ---- live page --------------------------------------------------------------
        const problems: string[] = [];
        page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
        page.on('console', (message) => {
          if (message.type() !== 'error') return;
          const where = message.location().url;
          problems.push(`console: ${message.text()}${where ? ` (${where})` : ''}`);
        });
        await page.addInitScript(() => {
          const w = window as unknown as { __csp: string[] };
          w.__csp = [];
          document.addEventListener('securitypolicyviolation', (event) => {
            w.__csp.push(`${event.violatedDirective} ${event.blockedURI || 'inline'}`);
          });
        });

        await page.goto(path, { waitUntil: 'networkidle' });
        expect(new URL(page.url()).pathname, 'not sent back to sign in').toBe(path.split('?')[0]);
        // Islands are `client:load`: wait until each has hydrated, then for the data it
        // fetches on mount.
        await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
        await page.waitForLoadState('networkidle');

        const live = await page.evaluate(() => {
          const shown = (el: Element) =>
            !(el as HTMLElement).hidden && (el as HTMLElement).offsetParent !== null;
          const main = document.querySelector('main.admin-main');
          const root = document.documentElement;
          return {
            csp: (window as unknown as { __csp: string[] }).__csp,
            onScreenErrors: [...document.querySelectorAll('.msg[data-kind="error"]')]
              .filter(shown)
              .map((el) => (el.textContent ?? '').trim()),
            pageOverflow: root.scrollWidth - root.clientWidth,
            mainOverflow: main ? main.scrollWidth - main.clientWidth : 0,
            sidebar: [...document.querySelectorAll('nav.admin-sidebar .admin-nav-group')].map(
              (group) => ({
                title: (group.querySelector('.admin-nav-title')?.textContent ?? '').trim(),
                // The label alone: a link also holds its icon and a count.
                links: [...group.querySelectorAll('a')].map(
                  (a) =>
                    `${(a.querySelector('.side__label')?.textContent ?? '').trim()} ${a.getAttribute('href') ?? ''}`,
                ),
              }),
            ),
          };
        });
        expect.soft(problems, 'page and console errors').toEqual([]);
        expect.soft(live.csp, 'CSP violations').toEqual([]);
        expect.soft(live.onScreenErrors, 'error messages on the screen').toEqual([]);
        expect
          .soft(live.pageOverflow, 'horizontal page overflow (px)')
          .toBeLessThanOrEqual(OVERFLOW_PX);
        expect
          .soft(live.mainOverflow, 'content area overflow (px)')
          .toBeLessThanOrEqual(OVERFLOW_PX);
        expect.soft(live.sidebar, `the ${role} sidebar`).toEqual(expectedSidebar(role));

        // ---- axe --------------------------------------------------------------------
        const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
        expect
          .soft(
            violations.map((v) => `${v.id} [${v.impact ?? 'n/a'}] ${v.nodes.length}x: ${v.help}`),
            `axe WCAG 2.2 A/AA on ${route.pattern}`,
          )
          .toEqual([]);
      });
    }
  });
}
