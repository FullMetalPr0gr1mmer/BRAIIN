import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { SKIP_REASON, authFile, staffEnv } from './staff';

/*
 * Integrations (Admin v2 U11), signed in, through the real Worker:
 *   screen     the four tiles as Admin and as SEO at 320, 390 and 1280 px, with a drawer open:
 *              zero axe violations, no sideways scroll; the captcha is read-only "Not set up",
 *              and only Admin (settings.general) is offered the Forms overview from it;
 *   verify     as SEO, a whole Search Console tag pasted is saved as its code: the tile says
 *              Set up, the home pages (EN and AR) carry the verification meta and About does
 *              not; Remove asks first, and the tag is gone again;
 *   refused    an id that is not a GA4 measurement id lands on its field with the schema's
 *              words, and nothing is saved;
 *   conflict   a second editor's save is a 409 with "Reload their version" (on the Calendly
 *              link since U15: no spec but tests/admin/ga4.e2e.ts, which runs alone, saves a
 *              GA4 id, because the CI preview is built with GA4 switched on and a saved id
 *              would put the loader on the pages parallel workers are reading).
 * Content Creator and Developer are refused by the server (tests/admin/refusals.e2e.ts,
 * through LOCKED_SCREENS). The tag's absence when nothing is set is the render test's
 * (tests/render/seoHeadVerification.spec.ts), never asserted on the shared preview here:
 * parallel workers read the home page. The code is on it only for the moments the verify
 * test holds it, and afterAll clears both values whatever failed.
 */

test.skip(!staffEnv(), SKIP_REASON);

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const CODE = 'U11e2eVerify_0123456789abc';
const TAG = `<meta name="google-site-verification" content="${CODE}">`;

async function ready(page: Page) {
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  await page.waitForLoadState('networkidle');
}

async function axeClean(page: Page, where: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    where,
  ).toEqual([]);
}

async function noSidewaysScroll(page: Page, where: string) {
  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over, `${where}: sideways scroll`).toBeLessThanOrEqual(0);
}

async function csrf(page: Page): Promise<{ 'x-csrf-token': string; origin: string }> {
  if (!page.url().includes('/admin')) await page.goto('/admin', { waitUntil: 'networkidle' });
  const token = await page.locator('meta[name="csrf-token"]').getAttribute('content');
  expect(token, 'the admin layout carries a CSRF token').toBeTruthy();
  return { 'x-csrf-token': token!, origin: new URL(page.url()).origin };
}

async function open(page: Page) {
  const res = await page.goto('/admin/integrations');
  expect(res?.status()).toBe(200);
  await ready(page);
}

const tile = (page: Page, key: string) => page.locator(`li[data-integration="${key}"]`);

/** Opens a tile's drawer: its button says Set up or Edit, with the tool's name. */
async function drawerOf(page: Page, name: string) {
  await page.getByRole('button', { name: new RegExp(`^(Set up|Edit) ${name}$`) }).click();
  const drawer = page.getByRole('dialog', { name });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Save' })).toBeVisible();
  return drawer;
}

/** Clears the values these tests set, as Admin, through the route (immediate: no release). */
async function clear(browser: Browser) {
  const context = await browser.newContext({ storageState: authFile('admin') });
  const page = await context.newPage();
  try {
    const headers = await csrf(page);
    const got = await page.request.get('/api/admin/integrations');
    expect(got.status(), await got.text()).toBe(200);
    const row = ((await got.json()) as { data: Record<string, unknown> }).data;
    if (
      row['search_console_token'] === null &&
      row['ga4_measurement_id'] === null &&
      row['calendly_url'] === null
    ) {
      return;
    }
    const res = await page.request.patch('/api/admin/integrations', {
      headers,
      data: {
        searchConsoleToken: null,
        ga4MeasurementId: null,
        calendlyUrl: null,
        version: Number(row['version'] ?? 0),
      },
    });
    expect(res.status(), await res.text()).toBe(200);
  } finally {
    await context.close();
  }
}

for (const role of ['admin', 'seo'] as const) {
  test.describe(`as ${role}, the screen`, () => {
    test.use({ storageState: authFile(role), contextOptions: { reducedMotion: 'reduce' } });

    for (const width of [320, 390, 1280]) {
      test(`the four tiles at ${width}px, and a drawer open`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await open(page);
        await expect(
          page.getByRole('list', { name: 'Integrations' }).locator(':scope > li'),
        ).toHaveCount(4);
        for (const key of ['ga4', 'searchConsole', 'calendly', 'captcha']) {
          await expect(tile(page, key)).toBeVisible();
        }
        // The captcha: Not set up, with nothing to set (owner item O-19).
        await expect(tile(page, 'captcha').locator('.badge')).toHaveText('Not set up');
        await expect(tile(page, 'captcha').getByRole('button')).toHaveCount(0);
        await expect(
          tile(page, 'captcha').getByRole('link', { name: 'How forms are protected' }),
        ).toHaveCount(role === 'admin' ? 1 : 0);
        await axeClean(page, `${role} tiles ${width}`);
        await noSidewaysScroll(page, `${role} tiles ${width}`);

        const drawer = await drawerOf(page, 'Calendly');
        await expect(drawer.getByLabel('Calendly booking link')).toBeVisible();
        await axeClean(page, `${role} drawer ${width}`);
        await noSidewaysScroll(page, `${role} drawer ${width}`);
        await drawer.getByRole('button', { name: 'Close' }).click();
        await expect(drawer).toBeHidden();
      });
    }
  });
}

test.describe('as SEO, end to end', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ storageState: authFile('seo'), contextOptions: { reducedMotion: 'reduce' } });

  test.afterAll(async ({ browser }) => {
    await clear(browser);
  });

  test('a pasted Search Console tag is saved as its code; the home pages carry it until Remove', async ({
    page,
  }) => {
    await open(page);
    let drawer = await drawerOf(page, 'Google Search Console');
    const box = drawer.getByLabel('Search Console verification code');
    await box.fill(`<meta name="google-site-verification" content="${CODE}" />`);
    await drawer.getByRole('button', { name: 'Save' }).click();
    await expect(
      drawer.getByRole('status').filter({ hasText: 'carries the tag now' }),
    ).toBeVisible();
    // What is stored is the code inside content, not the tag that was pasted.
    await expect(box).toHaveValue(CODE);
    await drawer.getByRole('button', { name: 'Close' }).click();
    await expect(drawer).toBeHidden();
    await expect(tile(page, 'searchConsole').locator('.badge')).toHaveText('Set up');

    for (const path of ['/', '/ar']) {
      const res = await page.request.get(path);
      expect(res.status(), path).toBe(200);
      const html = await res.text();
      expect(html, path).toContain(TAG);
      expect(html.split('google-site-verification'), path).toHaveLength(2);
    }
    const about = await page.request.get('/about');
    expect(await about.text()).not.toContain('google-site-verification');

    drawer = await drawerOf(page, 'Google Search Console');
    await drawer.getByRole('button', { name: 'Remove' }).click();
    const confirm = page.locator('dialog.admin-dialog');
    await expect(confirm).toContainText('Remove the Google Search Console setting?');
    await confirm.getByRole('button', { name: 'Remove' }).click();
    await expect(drawer).toBeHidden();
    await expect(tile(page, 'searchConsole').locator('.badge')).toHaveText('Not set up');
    const home = await page.request.get('/');
    expect(await home.text()).not.toContain(CODE);
  });

  test('an id that is not a GA4 measurement id is refused on its field, and nothing is saved', async ({
    page,
  }) => {
    await open(page);
    const drawer = await drawerOf(page, 'Google Analytics 4');
    await drawer.getByLabel('Google Analytics measurement ID').fill('UA-12345-1');
    const answer = page.waitForResponse(
      (r) => r.url().endsWith('/api/admin/integrations') && r.request().method() === 'PATCH',
    );
    await drawer.getByRole('button', { name: 'Save' }).click();
    const res = await answer;
    expect(res.status(), await res.text()).toBe(422);
    await expect(drawer).toContainText(
      'Use the measurement ID that starts with G-, like G-ABC123XYZ.',
    );
    const got = await page.request.get('/api/admin/integrations');
    const row = ((await got.json()) as { data: Record<string, unknown> }).data;
    expect(row['ga4_measurement_id']).toBeNull();
    await drawer.getByRole('button', { name: 'Close' }).click();
  });

  test('a second editor saving after the first gets "Reload their version"', async ({
    browser,
  }) => {
    const contexts = await Promise.all(
      [0, 1].map(() =>
        browser.newContext({
          storageState: authFile('seo'),
          reducedMotion: 'reduce',
        }),
      ),
    );
    try {
      const [first, second] = await Promise.all(contexts.map((c) => c.newPage()));
      await open(first!);
      await open(second!);
      const one = await drawerOf(first!, 'Calendly');
      const two = await drawerOf(second!, 'Calendly');
      await one.getByLabel('Calendly booking link').fill('https://calendly.com/u11-first');
      // Wait for the first save's answer, not for the screen: the typed value and "Version N"
      // are both on it before the PATCH returns, so the second save could otherwise land first.
      const firstSaved = first!.waitForResponse(
        (r) => r.url().endsWith('/api/admin/integrations') && r.request().method() === 'PATCH',
      );
      await one.getByRole('button', { name: 'Save' }).click();
      const saved = await firstSaved;
      expect(saved.status(), await saved.text()).toBe(200);
      await expect(one.getByLabel('Calendly booking link')).toHaveValue(
        'https://calendly.com/u11-first',
      );

      await two.getByLabel('Calendly booking link').fill('https://calendly.com/u11-second');
      const answer = second!.waitForResponse(
        (r) => r.url().endsWith('/api/admin/integrations') && r.request().method() === 'PATCH',
      );
      await two.getByRole('button', { name: 'Save' }).click();
      const res = await answer;
      expect(res.status(), await res.text()).toBe(409);
      await expect(two.getByRole('button', { name: 'Reload their version' })).toBeVisible();
      await two.getByRole('button', { name: 'Reload their version' }).click();
      await expect(two.getByLabel('Calendly booking link')).toHaveValue(
        'https://calendly.com/u11-first',
      );
    } finally {
      await Promise.all(contexts.map((c) => c.close()));
    }
  });
});
