import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '@playwright/test';
import { STAFF_ROLES, authFile, staffEnv } from './staff';
import { sweepRoutes } from './routes';

// Admin design capture (Admin v2 F0), not an assertion suite: full-page screenshots of
// every admin screen, for the side-by-side comparison with the client's prototype that
// each Admin v2 slice reports. Runs only when CAPTURE_DIR is set; the perf-seo-a11y e2e
// job sets it after the real suites and uploads the directory with the public capture.
//
// Admin sees every screen, so Admin is captured on all of them, at a laptop width and a
// phone width (where F2's shell puts the sidebar in a popover and wraps the topbar). The
// other roles are captured on the dashboard only, for their sidebars.
const DIR = process.env.CAPTURE_DIR;

const VIEWPORTS = [
  { tag: 'd', width: 1440, height: 900 },
  { tag: 'm', width: 390, height: 844 },
] as const;

function slug(path: string): string {
  return path.replace(/[/?=[\]]+/g, '_').replace(/^_|_$/g, '') || 'admin';
}

test.describe('admin design capture', () => {
  test.skip(!DIR || !staffEnv(), 'CAPTURE_DIR not set, or no local staff harness');
  test.describe.configure({ mode: 'parallel' });

  for (const role of STAFF_ROLES) {
    const routes = role === 'admin' ? sweepRoutes(role) : sweepRoutes(role).slice(0, 1);
    for (const vp of VIEWPORTS) {
      for (const route of routes) {
        const name = `admin-${role}-${vp.tag}-${slug(route.pattern)}`;
        test(name, async ({ browser }) => {
          const context = await browser.newContext({
            storageState: authFile(role),
            viewport: { width: vp.width, height: vp.height },
            reducedMotion: 'reduce',
          });
          const page = await context.newPage();
          let path = route.path;
          if (route.kind === 'edit') {
            const res = await page.request.get(`${route.listApi}?limit=1`);
            const body = res.ok()
              ? ((await res.json()) as { data?: { rows?: { id?: unknown }[] } })
              : {};
            const id = body.data?.rows?.[0]?.id;
            if (typeof id !== 'string') {
              await context.close();
              test.skip(true, `no row to open for ${route.pattern}`);
              return;
            }
            path = route.path.replace('[id]', id);
          }
          await page.goto(path, { waitUntil: 'networkidle' });
          await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
          await page.waitForLoadState('networkidle');
          await page.evaluate(() => document.fonts.ready);
          mkdirSync(join(DIR!, 'admin'), { recursive: true });
          await page.screenshot({ path: join(DIR!, 'admin', `${name}.png`), fullPage: true });
          if (vp.tag === 'd') {
            // The hydrated DOM beside its picture, so the admin can be restyled locally
            // against real markup and seeded data (F1 onwards). Markup to look at, not a
            // page to run: scripts dropped, the CSRF token blanked.
            const html = await page.evaluate(() => {
              const root = document.documentElement.cloneNode(true) as HTMLElement;
              root.querySelectorAll('script').forEach((node) => node.remove());
              root.querySelector('meta[name="csrf-token"]')?.setAttribute('content', '');
              return `<!doctype html>\n${root.outerHTML}`;
            });
            writeFileSync(join(DIR!, 'admin', `${name}.html`), html);
          }
          await context.close();
        });
      }
    }
  }
});
