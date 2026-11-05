import { expect, test, type Page } from '@playwright/test';
import { STAFF_ROLES, authFile, staffEnv } from '../admin/staff';
import { CAPTURE_VIEWPORTS, captureName, captureRoutes } from '../admin/routes';
import { resolvePath } from '../admin/openRoute';
import { GREETING_HOLDERS, GREETING_SOURCE, STEADY_GREETING } from './adminVisualSteady';

/*
 * Admin visual baselines (Admin v2 Z1, ui.md AV-34: "turns [the admin capture] into
 * toHaveScreenshot baselines at 1440 and 390, with time and count regions masked").
 *
 * The capture's set (tests/admin/routes.ts captureRoutes): Admin on every screen the sweep
 * opens, the other roles on their dashboard, for their sidebars; at 1440 x 900 and 390 x 844;
 * full page, reduced motion, animations off.
 *
 * NOT part of the required e2e job. Its name ends in `.ts`, not `.e2e.ts`, so no project of the
 * required job collects it; it runs only in the `admin-visual` project, which playwright.config.ts
 * adds when ADMIN_VISUAL is set, and only the hand-run workflow sets it
 * (.github/workflows/admin-visual.yml). Baselines are pictures of the Linux runner's rendering,
 * so they are made there, never on a builder's machine, and committed by hand under
 * tests/visual/admin-baselines/linux/ (docs/admin-v2/as-built/Z1.md, "Making the baselines").
 * The run is on a freshly seeded database, before any spec writes, so the rows are the seed's.
 */

const MODE = process.env['ADMIN_VISUAL'];

/** The admin's dates and relative times (src/lib/admin/relTime.ts), wherever they are printed. */
const WHEN =
  /\b(?:just now|\d+ (?:min|h|d) ago|in \d+ (?:min|h|d)|tomorrow|yesterday|today)\b|\b\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b|\b\d{1,2}:\d{2}\b|\b20\d\d\b/i;

/**
 * What changes from one run to the next: times and dates, counts, figures, charts, and the page
 * editor's live preview frame (the public page, with its own motion).
 */
const MASKED = [
  'time',
  '.cnt',
  '.stat',
  '.kpi__d',
  '.kpi__spark',
  '.dash__ago',
  '.dash-now__n',
  '.pg-card__ago',
  '.log__when',
  '.pub__when',
  '.goal__counts',
  '.crm-stage__count',
  '.chart-fig',
  'iframe',
].join(', ');

function masks(page: Page) {
  return [page.locator(MASKED), page.getByText(WHEN)];
}

/**
 * The dashboard's greeting ("Good evening, …") as one part of the day, wherever it is printed
 * (tests/visual/adminVisualSteady.ts says why a mask or a pinned clock cannot do this).
 */
async function steadyText(page: Page): Promise<void> {
  await page.evaluate(
    ({ holders, source, steady }) => {
      const pattern = new RegExp(source, 'g');
      for (const holder of document.querySelectorAll(holders)) {
        const walker = document.createTreeWalker(holder, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          node.nodeValue = (node.nodeValue ?? '').replace(pattern, steady);
        }
      }
    },
    { holders: GREETING_HOLDERS, source: GREETING_SOURCE, steady: STEADY_GREETING },
  );
}

test.describe('admin visual baselines', () => {
  test.skip(
    !MODE || !staffEnv(),
    'ADMIN_VISUAL not set (the hand-run workflow sets it), or no local staff harness',
  );
  test.describe.configure({ mode: 'parallel' });
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  for (const role of STAFF_ROLES) {
    test.describe(`as ${role}`, () => {
      test.use({ storageState: authFile(role) });

      for (const vp of CAPTURE_VIEWPORTS) {
        for (const route of captureRoutes(role)) {
          const name = captureName(role, vp.tag, route);
          test(name, async ({ page }) => {
            await page.setViewportSize({ width: vp.width, height: vp.height });
            const path = await resolvePath(page, route);
            test.skip(path === null, `the seed has no row for ${route.pattern}`);
            await page.goto(path!, { waitUntil: 'load' });
            await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
            // The data each island fetches on mount. Bounded: the page editor's and the
            // template editors' live preview frame (E2) can keep the network busy, and its
            // picture is masked anyway.
            await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
            await page.evaluate(() => document.fonts.ready);
            await steadyText(page);
            await expect(page).toHaveScreenshot(`${name}.png`, {
              fullPage: true,
              animations: 'disabled',
              caret: 'hide',
              mask: masks(page),
              // Anti-aliasing noise only: a moved or recoloured element is far more.
              maxDiffPixelRatio: 0.002,
              timeout: 20_000,
            });
          });
        }
      }
    });
  }
});
