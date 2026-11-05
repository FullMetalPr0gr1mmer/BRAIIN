import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { SKIP_REASON, STAFF_ROLES, authFile, staffEnv } from './staff';
import { routeKey, sweepRoutes, type SweepRoute } from './routes';
import { pathForSlug, resolvePath } from './openRoute';
import { LAPTOP, casesFor, type DialogCase, type Step, type Target } from './dialogs';

/*
 * The per-role axe matrix with dialogs open (Admin v2 Z1, ui.md AV-34: "Per-role axe with
 * dialogs open across every admin route"). The F0 sweep (sweep.e2e.ts) opens every screen each
 * role's sidebar offers and runs axe on it as it loads; this opens the dialogs on those screens.
 * The cases are tests/admin/dialogs.ts's; a case runs for every role whose sweep has its screen
 * and who sees its trigger, at each of its widths.
 *
 * One test per role, case and width:
 *   open     the screen (an edit screen on the row the sweep opens, or the named one), then
 *            the case's steps;
 *   dialog   exactly one open <dialog> (or the case's popover), with an accessible name, the
 *            case's when it names one (a dialog must be named, WCAG 4.1.2);
 *   axe      zero WCAG 2.2 A/AA violations with it open, as on every admin screen;
 *   close    Escape closes it, and focus goes back to an element on screen, never <body>
 *            (WCAG 2.4.3; useDialog's and ChromeDrawer's return rule, src/lib/admin/focusReturn.ts).
 *
 * Opening a dialog writes nothing: every case's trigger only opens, and Escape cancels. Never
 * `networkidle` after the load: the page editor's live preview frame (E2) keeps the network busy.
 */

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test.skip(!staffEnv(), SKIP_REASON);
test.use({ contextOptions: { reducedMotion: 'reduce' } });

function locate(page: Page, target: Target): Locator {
  const scope: Page | Locator = target.within ? locate(page, target.within) : page;
  const found =
    'css' in target
      ? scope.locator(target.css)
      : scope.getByRole(target.role, {
          name: target.name,
          ...(target.exact ? { exact: true } : {}),
        });
  return target.first ? found.first() : found;
}

async function run(page: Page, step: Step): Promise<void> {
  if ('keys' in step) {
    await page.keyboard.press(step.keys);
    return;
  }
  if ('press' in step) {
    const control = locate(page, step.press);
    await control.focus();
    await control.press('Enter');
    return;
  }
  const control = locate(page, step.click);
  if (step.optional && !(await control.isVisible())) return;
  await control.click();
}

/**
 * Until no request of the page has been in flight for half a second (at most ten): the
 * load-state `networkidle` fires once per navigation, so it cannot wait for what a dialog asks
 * for after it opens.
 */
async function quiet(page: Page): Promise<void> {
  let inFlight = 0;
  let last = Date.now();
  const start = () => {
    inFlight += 1;
    last = Date.now();
  };
  const end = () => {
    inFlight = Math.max(0, inFlight - 1);
    last = Date.now();
  };
  page.on('request', start);
  page.on('requestfinished', end);
  page.on('requestfailed', end);
  try {
    const deadline = Date.now() + 10_000;
    // The first tick lets a request the open just started be counted.
    await page.waitForTimeout(100);
    while (Date.now() < deadline && (inFlight > 0 || Date.now() - last < 500)) {
      await page.waitForTimeout(100);
    }
  } finally {
    page.off('request', start);
    page.off('requestfinished', end);
    page.off('requestfailed', end);
  }
}

async function pathOf(page: Page, route: SweepRoute, c: DialogCase): Promise<string | null> {
  if (route.kind === 'edit' && c.slug) return pathForSlug(page, route, c.slug);
  return resolvePath(page, route);
}

for (const role of STAFF_ROLES) {
  const routes = new Map(sweepRoutes(role).map((route) => [routeKey(route), route]));
  const cases = casesFor(role, new Set(routes.keys()));

  test.describe(`as ${role}`, () => {
    test.use({ storageState: authFile(role) });

    for (const c of cases) {
      for (const width of c.widths ?? [LAPTOP]) {
        test(`${c.id} at ${width}`, async ({ page }) => {
          // The page editor's preview frame (E2) puts the public page under every axe run.
          if (c.slow) test.slow();
          await page.setViewportSize({ width, height: 900 });
          const route = routes.get(c.screen)!;
          const path = await pathOf(page, route, c);
          test.skip(path === null, `the seed has no row for ${c.screen}`);

          await page.goto(path!, { waitUntil: 'load' });
          expect(new URL(page.url()).pathname, 'not sent back to sign in').toBe(
            path!.split('?')[0],
          );
          await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);

          for (const step of c.open) await run(page, step);

          // ---- the dialog ------------------------------------------------------------
          const opened = c.popover
            ? page.locator(`${c.popover}:popover-open`)
            : page.locator('dialog[open]');
          await expect(opened, `${c.id}: one open dialog`).toHaveCount(1);
          await expect(opened).toBeVisible();
          if (!c.popover) {
            await expect(opened, `${c.id}: the dialog's name`).toHaveAccessibleName(c.name ?? /\S/);
          }
          // What the dialog reads as it opens (a picker's pictures, a drawer's record), so axe
          // sees it loaded. Not with the page editor's live preview frame, which stays busy.
          if (!c.slow) await quiet(page);

          // ---- axe with it open --------------------------------------------------------
          const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
          expect
            .soft(
              violations.map(
                (v) =>
                  `${v.id} [${v.impact ?? 'n/a'}] ${v.nodes.length}x: ${v.help} at ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
              ),
              `axe WCAG 2.2 A/AA with ${c.id} open on ${c.screen} at ${width}px`,
            )
            .toEqual([]);

          // ---- Escape closes it; focus comes back to the page --------------------------
          await page.keyboard.press('Escape');
          await expect(opened, `${c.id}: Escape closes it`).toHaveCount(0);
          const focus = await page.evaluate(() => {
            const el = document.activeElement;
            if (!el || el === document.body) return 'body';
            const shown = (el as HTMLElement).getClientRects().length > 0;
            return shown ? 'shown' : `hidden ${el.tagName.toLowerCase()}`;
          });
          expect.soft(focus, `${c.id}: focus after Escape`).toBe('shown');
        });
      }
    }
  });
}
