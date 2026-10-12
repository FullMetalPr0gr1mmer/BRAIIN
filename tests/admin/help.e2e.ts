import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { SKIP_REASON, authFile, staffEnv } from './staff';

// The help centre (Admin v2 U16) in a real browser, signed in: the topbar's "?" opens the
// drawer with JS and is a plain link to /admin/help without it; the drawer lists the guides
// for the screen it was opened on first; a search finds a guide in either language and
// never one the role may not read; a guide opens in place with its heading focused, reads in
// Arabic (RTL) on request, and "All guides" goes back to the row it came from; axe finds
// nothing with the drawer open, in English and in Arabic; Escape closes it and focus returns
// to the "?". The page itself, in its four views, is in the per-role sweep (routes.ts
// EXTRA_LINKS). The guides are the ones migration 0046 seeds into every tenant.

test.skip(!staffEnv(), SKIP_REASON);
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function ready(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
}

async function expectNoAxeViolations(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(
    violations.map((v) => `${v.id} [${v.impact ?? 'n/a'}] ${v.nodes.length}x: ${v.help}`),
    label,
  ).toEqual([]);
}

const helpButton = (page: Page) => page.locator('.admin-topbar [data-open="help"]');

test.describe('as developer', () => {
  test.use({ storageState: authFile('developer') });

  test('"?" opens the drawer on this screen’s guides; a guide reads in English and Arabic', async ({
    page,
  }) => {
    await ready(page, '/admin/leads');
    const trigger = helpButton(page);
    await expect(trigger).toHaveAttribute('href', '/admin/help?screen=%2Fadmin%2Fleads');
    await expect(trigger).toHaveAccessibleName('Help centre');
    await trigger.click();

    const drawer = page.getByRole('dialog', { name: 'Help centre' });
    await expect(drawer).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/leads$/);
    await expect(drawer.getByRole('searchbox', { name: 'Search the guides' })).toBeFocused();

    // This screen's guides first, then every guide the role may read.
    const onScreen = drawer.getByRole('list', { name: /^on this screen$/i });
    await expect(onScreen.getByRole('link', { name: /Working with leads/ })).toBeVisible();
    const all = drawer.getByRole('list', { name: /^all guides$/i });
    await expect(all.getByRole('link', { name: /Maintenance mode/ })).toBeVisible();
    // Developer holds no job applications: no guide about them is offered.
    await expect(all.getByRole('link', { name: /Job applications/ })).toHaveCount(0);
    await expectNoAxeViolations(page, 'developer: the help drawer');

    // A guide opens in place, its heading focused.
    await onScreen.getByRole('link', { name: /Working with leads/ }).click();
    const heading = drawer.getByRole('heading', { level: 3, name: 'Working with leads' });
    await expect(heading).toBeFocused();
    await expect(drawer.locator('.hc-art')).toContainText('Reveal contact details and notes');
    await expect(page).toHaveURL(/\/admin\/leads$/);

    // The Arabic text, marked as Arabic and right to left.
    await drawer.getByRole('button', { name: 'اقرأ بالعربية' }).click();
    await expect(drawer.locator('#help-article-title')).toHaveAttribute('lang', 'ar');
    await expect(drawer.locator('.hc-art')).toHaveAttribute('dir', 'rtl');
    await expect(drawer.locator('.hc-art')).toContainText('العملاء المحتملين');
    await expectNoAxeViolations(page, 'developer: a guide in Arabic');

    // Back to the list, onto the row the guide was opened from.
    await drawer.getByRole('button', { name: /^all guides$/i }).click();
    await expect(
      drawer.getByRole('list', { name: /^on this screen$/i }).getByRole('link', {
        name: /Working with leads/,
      }),
    ).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});

test.describe('as content_creator', () => {
  test.use({ storageState: authFile('content_creator') });

  test('search finds guides in either language, and never one the role may not read', async ({
    page,
  }) => {
    await ready(page, '/admin');
    await helpButton(page).click();
    const drawer = page.getByRole('dialog', { name: 'Help centre' });
    const search = drawer.getByRole('searchbox', { name: 'Search the guides' });

    await search.fill('draft');
    const results = drawer.getByRole('list', { name: /^results$/i });
    await expect(
      results.getByRole('link', { name: /Saving, publishing and scheduling/ }),
    ).toBeVisible();
    await expect(drawer.getByRole('status')).toHaveText(/guides? match/);

    // Arabic, folded: ta marbuta typed as ha still finds the guide.
    await search.fill('مسوده');
    await expect(
      results.getByRole('link', { name: /Saving, publishing and scheduling/ }),
    ).toBeVisible();

    // Leads and their personal data are not Content Creator's: their guides never show.
    await search.fill('leads');
    await expect(drawer.getByRole('status')).not.toHaveText('');
    await expect(drawer.getByRole('link', { name: /Working with leads/ })).toHaveCount(0);
    await expect(drawer.getByRole('link', { name: /Personal data/ })).toHaveCount(0);

    await search.fill('zzzz-nothing');
    await expect(drawer.getByRole('status')).toHaveText('No guide matches that. Try other words.');
    await expectNoAxeViolations(page, 'content_creator: a search with no result');
  });

  test('a guide the role may not read is the same 404 as no guide, on the page and the API', async ({
    page,
  }) => {
    const pageRes = await page.request.get('/admin/help?guide=working-with-leads');
    expect(pageRes.status()).toBe(404);
    const apiRes = await page.request.get('/api/admin/help/article?slug=working-with-leads');
    expect(apiRes.status()).toBe(404);
    const missing = await page.request.get('/api/admin/help/article?slug=no-such-guide');
    expect(missing.status()).toBe(404);
  });
});

test.describe('without JS', () => {
  test.use({ storageState: authFile('seo'), javaScriptEnabled: false });

  test('"?" is a link to the help page, which lists this screen’s guides and reads one', async ({
    page,
  }) => {
    await page.goto('/admin/redirects');
    await helpButton(page).click();
    await expect(page).toHaveURL(/\/admin\/help\?screen=%2Fadmin%2Fredirects$/);
    const onScreen = page.getByRole('list', { name: /^on this screen$/i });
    await onScreen.getByRole('link', { name: /SEO defaults and redirects/ }).click();
    await expect(page).toHaveURL(/\/admin\/help\?guide=seo-and-redirects$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'SEO defaults and redirects' }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'اقرأ بالعربية' }).click();
    await expect(page.locator('.hc-art')).toHaveAttribute('lang', 'ar');
  });
});
