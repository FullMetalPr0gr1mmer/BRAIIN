import { expect, test } from '@playwright/test';
import { SKIP_REASON, authFile, staffEnv } from './staff';

// The admin shell (Admin v2 F2): the sidebar is a popover below 900px, the skip link
// leads to the content, nothing scrolls sideways at 320px (WCAG 1.4.10), and an area's
// tabs show only the screens the role may open. The per-role sweep (sweep.e2e.ts) covers
// every screen at desktop width; this file covers what only a narrow screen or a
// keyboard shows.

test.skip(!staffEnv(), SKIP_REASON);

test.describe('the shell on a phone', () => {
  test.use({
    storageState: authFile('admin'),
    viewport: { width: 390, height: 844 },
    contextOptions: { reducedMotion: 'reduce' },
  });

  test('the sidebar is a popover: Menu opens it, Escape closes it', async ({ page }) => {
    await page.goto('/admin', { waitUntil: 'networkidle' });
    const side = page.locator('#admin-side');
    await expect(side).toBeHidden();

    const menu = page.getByRole('button', { name: 'Menu' });
    await menu.click();
    await expect(side).toBeVisible();
    await expect(side.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    expect(await side.evaluate((el) => el.matches(':popover-open'))).toBe(true);

    await page.keyboard.press('Escape');
    await expect(side).toBeHidden();
  });

  for (const path of ['/admin', '/admin/services', '/admin/services/new']) {
    test(`nothing scrolls sideways at 320px: ${path}`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 720 });
      await page.goto(path, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(2);
    });
  }
});

test.describe('the shell from a keyboard', () => {
  test.use({ storageState: authFile('admin') });

  test('the first Tab reaches the skip link, which moves focus to the content', async ({
    page,
  }) => {
    await page.goto('/admin/services', { waitUntil: 'networkidle' });
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(page.locator('main#content')).toBeFocused();
  });

  // WCAG 2.2 2.4.11: the topbar sticks, and a browser does not scroll a control it
  // focuses when the control is already inside the viewport, even if a sticky bar covers
  // it. The page's scroll padding (admin.css) is what makes it scroll the control clear.
  // The phone width is the case the measured bar height exists for: the bar wraps there.
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 390, height: 844 },
  ]) {
    test(`a field focused from the keyboard is not left under the topbar at ${viewport.width}px`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto('/admin/services/new', { waitUntil: 'networkidle' });
      await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
      const bar = page.locator('.admin-topbar');
      const field = page.locator('main input[type="text"]').first();
      await field.focus();
      await page.keyboard.press('Tab');

      // Scroll the field up under the bar, then come back to it with Shift+Tab.
      await field.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 4));
      const covered = await field.boundingBox();
      const barBox = await bar.boundingBox();
      expect(covered!.y, 'the field starts under the bar').toBeLessThan(barBox!.y + barBox!.height);

      await page.keyboard.press('Shift+Tab');
      await expect(field).toBeFocused();
      await expect
        .poll(async () => {
          const [fieldNow, barNow] = [await field.boundingBox(), await bar.boundingBox()];
          return fieldNow!.y - (barNow!.y + barNow!.height);
        })
        .toBeGreaterThanOrEqual(0);
    });
  }

  test('the sidebar stays in view when a long page scrolls', async ({ page }) => {
    await page.goto('/admin', { waitUntil: 'networkidle' });
    // The WINDOW scrolls. A mouse wheel over the sidebar would scroll the sidebar's own
    // list instead (it scrolls when the menu is taller than the screen).
    await page.evaluate(() => window.scrollTo(0, 4000));
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await expect(
      page.locator('#admin-side').getByRole('link', { name: 'Dashboard' }),
    ).toBeInViewport();
  });
});

test.describe("an area's tabs", () => {
  test.describe('as admin', () => {
    test.use({ storageState: authFile('admin') });

    test('Services shows its three screens, the current one marked', async ({ page }) => {
      await page.goto('/admin/disciplines', { waitUntil: 'networkidle' });
      const tabs = page.getByRole('navigation', { name: 'Services sections' });
      await expect(tabs.getByRole('link')).toHaveText(['Services', 'Disciplines', 'Case studies']);
      await expect(tabs.getByRole('link', { name: 'Disciplines' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      // The sidebar lights the area's link for a folded screen.
      await expect(page.locator('#admin-side a[aria-current="page"] .side__label')).toHaveText(
        'Services',
      );
    });
  });

  test.describe('as seo', () => {
    test.use({ storageState: authFile('seo') });

    test('Services shows no tab row: SEO may open only the services list', async ({ page }) => {
      await page.goto('/admin/services', { waitUntil: 'networkidle' });
      await expect(page.getByRole('navigation', { name: 'Services sections' })).toHaveCount(0);
    });
  });
});
