import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { Role } from '@/lib/auth/types';
import { SKIP_REASON, authFile, staffEnv } from './staff';

// Website stats and site health (Admin v2 U2) in a real browser, signed in: each role opens
// what it may (the tabs and the ranges are links of one server-rendered page), Admin clears
// the log through the kit's Modal and Developer sees no Clear, /admin/logs lands on the
// Errors tab, and every view passes axe (WCAG 2.2 A/AA, target size included) with nothing
// scrolling sideways at 320, 390 and 1280px; a table wider than a phone scrolls inside a
// region the keyboard reaches. The per-role sweep opens the same views at 1280
// (routes.ts EXTRA_LINKS); tests/admin/refusals.e2e.ts proves the server's 403s.

test.skip(!staffEnv(), SKIP_REASON);
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const WIDTHS = [320, 390, 1280];

async function open(page: Page, path: string) {
  const res = await page.goto(path, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  return res;
}

async function check(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect
    .soft(
      violations.map((v) => `${v.id} [${v.impact ?? 'n/a'}] ${v.nodes.length}x: ${v.help}`),
      `axe on ${label}`,
    )
    .toEqual([]);
  const overflow = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect.soft(overflow, `horizontal overflow on ${label}`).toBeLessThanOrEqual(2);
  // No error box: the readers answered.
  await expect.soft(page.locator('main .msg[data-kind="error"]')).toHaveCount(0);
}

const STATS = [
  '/admin/analytics',
  '/admin/analytics?range=7',
  '/admin/analytics?range=90',
  '/admin/analytics?tab=pages',
  '/admin/analytics?tab=pages&range=7',
];
const SEARCH = ['/admin/analytics/search', '/admin/analytics/search?range=90'];
const HEALTH = [
  '/admin/site-health',
  '/admin/site-health?tab=speed',
  '/admin/site-health?tab=errors',
  '/admin/site-health?tab=seo',
];

const VIEWS: Record<Role, string[]> = {
  admin: [...STATS, ...SEARCH, ...HEALTH],
  developer: [...STATS, ...SEARCH, ...HEALTH],
  seo: [...STATS, ...SEARCH],
  content_creator: STATS,
};

for (const role of Object.keys(VIEWS) as Role[]) {
  test.describe(`as ${role}`, () => {
    test.use({ storageState: authFile(role) });

    for (const width of WIDTHS) {
      test(`every view it may open, at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        for (const path of VIEWS[role]) {
          const res = await open(page, path);
          expect(res?.status(), `${path} as ${role}`).toBe(200);
          await check(page, `${path} at ${width}px`);
        }
      });
    }
  });
}

test.describe('the tabs and ranges are links that keep each other', () => {
  test.use({ storageState: authFile('admin') });

  test('Website stats: a range keeps the tab, a tab keeps the range', async ({ page }) => {
    await open(page, '/admin/analytics?tab=pages');
    await page
      .getByRole('navigation', { name: 'Date range' })
      .getByRole('link', { name: '7 days' })
      .click();
    await expect(page).toHaveURL(/\/admin\/analytics\?tab=pages&range=7$/);
    await expect(
      page
        .getByRole('navigation', { name: 'Website stats views' })
        .getByRole('link', { name: 'Pages' }),
    ).toHaveAttribute('aria-current', 'page');
    await page
      .getByRole('navigation', { name: 'Website stats views' })
      .getByRole('link', { name: 'Overview' })
      .click();
    await expect(page).toHaveURL(/\/admin\/analytics\?range=7$/);
    await expect(
      page.getByText('First-party stats from visitors who accepted analytics cookies.'),
    ).toBeVisible();
  });

  test('a wide table scrolls inside a region the keyboard reaches', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await open(page, '/admin/analytics/search');
    const region = page.getByRole('region', { name: 'Top searches, the most frequent first' });
    await region.focus();
    await expect(region).toBeFocused();
  });
});

test.describe('the error log', () => {
  test('/admin/logs lands on site health’s Errors tab', async ({ browser }) => {
    const context = await browser.newContext({ storageState: authFile('developer') });
    const page = await context.newPage();
    await open(page, '/admin/logs');
    await expect(page).toHaveURL(/\/admin\/site-health\?tab=errors$/);
    await expect(
      page
        .getByRole('navigation', { name: 'Site health views' })
        .getByRole('link', { name: 'Errors' }),
    ).toHaveAttribute('aria-current', 'page');
    // Developer reads the log but may not clear it (logs.clear is Admin's).
    await expect(page.getByRole('button', { name: 'Clear logs' })).toHaveCount(0);
    await context.close();
  });

  test('Admin clears it through the modal, choosing how much', async ({ browser }) => {
    const context = await browser.newContext({ storageState: authFile('admin') });
    const page = await context.newPage();
    await open(page, '/admin/site-health?tab=errors');
    await page.getByRole('button', { name: 'Clear logs' }).click();
    // Found by its role, not its name: the title follows the choice. One dialog is open.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toHaveCount(1);
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleName('Clear logs older than 30 days?');
    // A destructive dialog starts on Cancel.
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await dialog.getByLabel('Older than 7 days').check();
    await expect(dialog).toHaveAccessibleName('Clear logs older than 7 days?');
    await dialog.getByLabel('All entries').check();
    await expect(dialog).toHaveAccessibleName('Clear every log entry?');
    const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(
      violations.map((v) => v.id),
      'axe with the dialog open',
    ).toEqual([]);
    await dialog.getByLabel('Older than 30 days').check();
    await expect(dialog).toHaveAccessibleName('Clear logs older than 30 days?');
    const cleared = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/admin/logs' && r.request().method() === 'DELETE',
    );
    await dialog.getByRole('button', { name: 'Clear logs' }).click();
    const res = await cleared;
    expect(res.status()).toBe(200);
    expect(new URL(res.url()).searchParams.get('olderThanDays')).toBe('30');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/admin\/site-health\?tab=errors$/);
    await context.close();
  });
});
