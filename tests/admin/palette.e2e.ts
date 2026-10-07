import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator } from '@playwright/test';
import { SKIP_REASON, authFile, staffEnv } from './staff';

// The command palette (Admin v2 F3) in a real browser, signed in: the shortcuts, the
// combobox keyboard model, a record found by the server search, focus return, the status
// line, and axe with the dialog open, full and empty. The model's rules are unit-tested
// (tests/lib/adminPalette.spec.ts).

test.skip(!staffEnv(), SKIP_REASON);
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test.describe('as admin', () => {
  test.use({ storageState: authFile('admin') });

  test.beforeEach(async ({ page }) => {
    await page.goto('/admin', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  });

  test('Ctrl+K opens it, the best match is active, Enter goes there', async ({ page }) => {
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Search the admin' });
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole('combobox');
    await expect(input).toBeFocused();

    await input.fill('case st');
    const first = dialog.getByRole('option').first();
    await expect(first).toContainText('Case studies');
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await expect(input).toHaveAttribute('aria-activedescendant', (await first.getAttribute('id'))!);

    await page.keyboard.press('Enter');
    await page.waitForURL((url) => url.pathname === '/admin/service-cases');
  });

  test('the arrows walk the list and wrap at both ends; Enter takes the option reached', async ({
    page,
  }) => {
    // One character: the server is not asked, so the list cannot change under the keys.
    // For Admin, "n" lists Numbers, then the six "New …" actions, "New redirect" last.
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Search the admin' });
    const input = dialog.getByRole('combobox');
    await input.fill('n');
    const options = dialog.getByRole('option');
    await expect(options.last()).toContainText('New redirect');
    expect(await options.count()).toBeGreaterThanOrEqual(3);

    const expectActive = async (option: Locator) => {
      await expect(option).toHaveAttribute('aria-selected', 'true');
      await expect(dialog.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);
      await expect(input).toHaveAttribute(
        'aria-activedescendant',
        (await option.getAttribute('id'))!,
      );
    };
    await expectActive(options.first());
    await page.keyboard.press('ArrowUp'); // from the first, round to the last
    await expectActive(options.last());
    await page.keyboard.press('ArrowDown'); // from the last, round to the first
    await expectActive(options.first());
    await page.keyboard.press('ArrowDown');
    await expectActive(options.nth(1));
    await page.keyboard.press('ArrowUp');
    await expectActive(options.first());
    // The keys move the selection, not the caret (preventDefault): it stays after the "n".
    expect(await input.evaluate((el) => (el as HTMLInputElement).selectionStart)).toBe(1);

    await page.keyboard.press('ArrowUp');
    await expectActive(options.last());
    await page.keyboard.press('Enter');
    await page.waitForURL((url) => url.pathname === '/admin/redirects/new');
  });

  test('finds a record through the server search and opens it', async ({ page }) => {
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Search the admin' });
    await dialog.getByRole('combobox').fill('logo');
    const record = dialog.getByRole('option', { name: /Logo Design/ }).first();
    await expect(record).toBeVisible();
    await record.click();
    await page.waitForURL((url) => /^\/admin\/services\/[0-9a-f-]{36}$/.test(url.pathname));
  });

  test('ends with the full results page for the query', async ({ page }) => {
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Search the admin' });
    await dialog.getByRole('combobox').fill('brand');
    await expect(dialog.getByRole('option').last()).toContainText('See all results for “brand”');
  });

  test('the trigger opens it and Escape gives focus back to the trigger', async ({ page }) => {
    const trigger = page.locator('.top__search');
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Search the admin' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('a bare "/" never opens it: no one-character shortcut (WCAG 2.1.4)', async ({ page }) => {
    // The handler would open the dialog during the keydown itself, so it is either open
    // by the time press() returns or not at all.
    await page.keyboard.press('/');
    const dialog = page.getByRole('dialog', { name: 'Search the admin' });
    await expect(dialog).toBeHidden();
    await page.keyboard.press('Control+k');
    await expect(dialog).toBeVisible();
  });

  test('meets WCAG 2.2 A/AA with the palette open, its full list scrolling', async ({ page }) => {
    // An empty query lists every screen: the longest list, so the scroll region is real.
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('option').first()).toBeVisible();
    const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  test('says "No matches." from outside the list, and meets WCAG 2.2 A/AA', async ({ page }) => {
    // One character, so the server is not asked: no screen or action has a word in "x".
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Search the admin' });
    await dialog.getByRole('combobox').fill('x');
    await expect(dialog.getByRole('option')).toHaveCount(0);
    await expect(dialog.getByRole('status')).toHaveText('No matches.');
    // A listbox may own only options and groups (axe aria-required-children).
    await expect(dialog.getByRole('listbox').getByRole('status')).toHaveCount(0);
    const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  test('says "Searching…" while the server search is out', async ({ page }) => {
    // The search answers only when released, so the in-flight state can be seen.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    await page.route(/\/api\/admin\/search\?/, async (route) => {
      await held;
      await route.continue();
    });
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Search the admin' });
    await dialog.getByRole('combobox').fill('logo');
    const status = dialog.getByRole('status');
    await expect(status).toHaveText('Searching…');
    release();
    await expect(dialog.getByRole('option', { name: /Logo Design/ }).first()).toBeVisible();
    await expect(status).toBeEmpty();
  });

  test('says when an area could not be searched, not just a shorter list', async ({ page }) => {
    // searchAdmin reports an entity whose query failed (and logs it); stand that answer in.
    await page.route(/\/api\/admin\/search\?/, (route) =>
      route.fulfill({ json: { ok: true, data: { groups: [], failed: ['Team & authors'] } } }),
    );
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Search the admin' });
    await dialog.getByRole('combobox').fill('logo');
    await expect(dialog.getByRole('status')).toHaveText('Some areas could not be searched.');
  });
});

test.describe('as seo', () => {
  test.use({ storageState: authFile('seo') });

  test('offers only the actions SEO may take', async ({ page }) => {
    await page.goto('/admin', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Search the admin' });
    await dialog.getByRole('combobox').fill('new');
    await expect(dialog.getByRole('option', { name: /New redirect/ })).toBeVisible();
    await expect(dialog.getByRole('option', { name: /New service/ })).toHaveCount(0);
  });
});
