import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import type { Role } from '@/lib/auth/types';
import { SKIP_REASON, authFile, staffEnv } from './staff';

/*
 * The bell's settings (Admin v2 U11, /admin/settings/notifications), signed in:
 *   per role  one switch per kind of item the role's bell shows, named as the screen names
 *             it, and no other (a preference quiets the bell, never widens it); axe clean and
 *             no sideways scroll at 390 px; the account drawer and the bell's page link here;
 *   saved     as Sales, Maintenance mode off is saved, survives a reload, and goes back on.
 * The save runs as Sales on purpose: the dashboard spec saves the four CMS roles'
 * preferences (one version per row, so a parallel save there would be a 409 here, or there),
 * and the health spec reads Admin's and Developer's bell. afterAll turns it back on whatever
 * failed.
 */

test.skip(!staffEnv(), SKIP_REASON);
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const PATH = '/admin/settings/notifications';
const ENDPOINT = '/api/admin/me/notification-settings';

/**
 * The switches each role is offered, in the bell's order (each source's `visible`). Admin v2
 * R11's "Scheduled releases" is every publishing role's (not Sales's).
 */
const SWITCHES: Record<Role, string[]> = {
  admin: [
    'New inquiries',
    'New job applications',
    'Going live today',
    'Maintenance mode',
    'Site health',
    'Scheduled releases',
  ],
  content_creator: ['Going live today', 'Maintenance mode', 'Scheduled releases'],
  seo: ['Maintenance mode', 'Scheduled releases'],
  developer: ['New inquiries', 'Maintenance mode', 'Site health', 'Scheduled releases'],
  sales: ['New inquiries', 'Maintenance mode'],
};

async function open(page: Page, path = PATH) {
  const res = await page.goto(path);
  expect(res?.status(), path).toBe(200);
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  await page.waitForLoadState('networkidle');
}

async function csrf(page: Page): Promise<{ 'x-csrf-token': string; origin: string }> {
  if (!page.url().includes('/admin')) await page.goto('/admin', { waitUntil: 'networkidle' });
  const token = await page.locator('meta[name="csrf-token"]').getAttribute('content');
  expect(token, 'the admin layout carries a CSRF token').toBeTruthy();
  return { 'x-csrf-token': token!, origin: new URL(page.url()).origin };
}

/** Turns Sales's Maintenance mode back on, through the route. */
async function restore(browser: Browser) {
  const context = await browser.newContext({ storageState: authFile('sales') });
  const page = await context.newPage();
  try {
    const headers = await csrf(page);
    const got = await page.request.get(ENDPOINT);
    expect(got.status(), await got.text()).toBe(200);
    const now = ((await got.json()) as { data: Record<string, unknown> }).data;
    if (now['maintenance'] === true) return;
    const res = await page.request.patch(ENDPOINT, {
      headers,
      data: { version: Number(now['version'] ?? 0), maintenance: true },
    });
    expect(res.status(), await res.text()).toBe(200);
  } finally {
    await context.close();
  }
}

for (const role of Object.keys(SWITCHES) as Role[]) {
  test.describe(`as ${role}`, () => {
    test.use({ storageState: authFile(role) });

    test('one switch per kind its bell shows; axe clean at 390px', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 900 });
      await open(page);
      const switches = page.getByRole('switch');
      await expect(switches).toHaveCount(SWITCHES[role].length);
      for (const [i, name] of SWITCHES[role].entries()) {
        await expect(switches.nth(i)).toHaveAccessibleName(name);
      }
      const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
      expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
      const over = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(over, 'sideways scroll').toBeLessThanOrEqual(0);
    });
  });
}

test.describe('the way in', () => {
  test.use({ storageState: authFile('seo') });

  test('the account drawer and the bell page link to the settings', async ({ page }) => {
    await open(page, '/admin/notifications');
    await page.getByRole('link', { name: 'Notification settings' }).click();
    await expect(page).toHaveURL(new RegExp(`${PATH}$`));
    await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
    await page.locator('.side__user[data-open="account"]').click();
    const drawer = page.getByRole('dialog', { name: 'Your account' });
    await expect(drawer).toBeVisible();
    await drawer.getByRole('link', { name: 'Choose what the bell tells you' }).click();
    await expect(page).toHaveURL(new RegExp(`${PATH}$`));
  });
});

test.describe('as Sales, saved', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ storageState: authFile('sales') });

  test.afterAll(async ({ browser }) => {
    await restore(browser);
  });

  test('Maintenance mode off is saved, survives a reload, and goes back on', async ({ page }) => {
    await open(page);
    const maintenance = page.getByRole('switch', { name: 'Maintenance mode' });
    await expect(maintenance).toHaveAttribute('aria-checked', 'true');
    await maintenance.click();
    await expect(maintenance).toHaveAttribute('aria-checked', 'false');
    const saved = page.waitForResponse(
      (r) => r.url().endsWith(ENDPOINT) && r.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: 'Save' }).click();
    const res = await saved;
    expect(res.status(), await res.text()).toBe(200);

    await open(page);
    await expect(page.getByRole('switch', { name: 'Maintenance mode' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await expect(page.getByRole('switch', { name: 'New inquiries' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    await page.getByRole('switch', { name: 'Maintenance mode' }).click();
    const back = page.waitForResponse(
      (r) => r.url().endsWith(ENDPOINT) && r.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: 'Save' }).click();
    expect((await back).status()).toBe(200);
  });
});
