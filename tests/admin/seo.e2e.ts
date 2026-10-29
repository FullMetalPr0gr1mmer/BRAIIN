import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { RELEASES_OFF_ONLY, SKIP_REASON, authFile, releasesOn, staffEnv } from './staff';

/*
 * The SEO screen (Admin v2 U10), signed in, through the real Worker:
 *   tabs      Pages, Redirects and Site wide as Admin and as SEO at 320, 390 and 1280 px, the
 *             drawer open with both previews: zero axe violations, no sideways scroll;
 *   pages     a service's title in both languages, a share image from the library and Index
 *             off, saved: the row says Custom and Hidden, the public page's head carries the
 *             title, an absolute JPEG share image and noindex, and the sitemap leaves it out;
 *             put back, it is listed again. A second editor's save is a 409 with "Reload
 *             their version";
 *   redirects a rule created, edited and deleted in the drawer, the Sync to edge line kept;
 *             /admin/redirects answers on the tab;
 *   site      a noindex default asks for "noindex" typed before its button works, and Cancel
 *             puts the value back. NEVER saved: every parallel worker reads public heads.
 * Content Creator and Developer are refused by the server (tests/admin/refusals.e2e.ts,
 * through LOCKED_SCREENS).
 *
 * The service is booth-installation, which no other spec reads (its head and its sitemap line
 * change for a moment); every change is put back in afterAll, whatever failed.
 */

test.skip(!staffEnv(), SKIP_REASON);
// The release-mode rehearsal (Admin v2 R14-prep): written for releases off.
test.skip(releasesOn(), RELEASES_OFF_ONLY);

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const SLUG = 'booth-installation';
const STILL = 'A person in a black head wrap';
const TITLE = { en: 'Booth installation in Riyadh', ar: 'تركيب الأجنحة في الرياض' };

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

/** Presses a row action: they are drawn on hover or focus, so focus it and press Enter. */
async function press(page: Page, name: string | RegExp) {
  const button = page.getByRole('button', { name }).first();
  await button.focus();
  await page.keyboard.press('Enter');
}

for (const role of ['admin', 'seo'] as const) {
  test.describe(`as ${role}, every tab`, () => {
    test.use({ storageState: authFile(role), contextOptions: { reducedMotion: 'reduce' } });

    for (const width of [320, 390, 1280]) {
      test(`Pages, Redirects and Site wide at ${width}px, and the drawer open`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        for (const tab of ['pages', 'redirects', 'site']) {
          const res = await page.goto(`/admin/seo?tab=${tab}`);
          expect(res?.status(), tab).toBe(200);
          await ready(page);
          await expect(page.getByRole('navigation', { name: 'SEO views' })).toBeVisible();
          await axeClean(page, `${role} ${tab} ${width}`);
          await noSidewaysScroll(page, `${role} ${tab} ${width}`);
        }
        await page.goto('/admin/seo?tab=pages&type=service');
        await ready(page);
        await press(page, /^Edit SEO for /);
        const drawer = page.getByRole('dialog', { name: /^SEO: / });
        await expect(drawer).toBeVisible();
        await expect(
          drawer.getByRole('region', { name: 'Google preview', exact: true }),
        ).toBeVisible();
        await expect(
          drawer.getByRole('region', { name: 'Google preview in Arabic' }),
        ).toBeVisible();
        await expect(drawer.locator('.seo-preview__card[lang="ar"]')).toHaveAttribute('dir', 'rtl');
        await axeClean(page, `${role} drawer ${width}`);
        await noSidewaysScroll(page, `${role} drawer ${width}`);
        await page.keyboard.press('Escape');
        await expect(drawer).toBeHidden();
      });
    }
  });
}

test.describe('the Pages tab, end to end', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ storageState: authFile('admin'), contextOptions: { reducedMotion: 'reduce' } });

  let entityId = '';
  let label = '';

  async function current(page: Page) {
    const res = await page.request.get(
      `/api/admin/entity-seo?entityType=service&entityId=${entityId}`,
    );
    expect(res.status()).toBe(200);
    return ((await res.json()) as { data: Record<string, unknown> }).data;
  }

  /** Puts the service's SEO back to nothing of its own (the page then follows its defaults). */
  async function restore(browser: Browser) {
    if (!entityId) return;
    const context = await browser.newContext({ storageState: authFile('admin') });
    const page = await context.newPage();
    try {
      const row = await current(page);
      const res = await page.request.put('/api/admin/entity-seo', {
        headers: await csrf(page),
        data: { entityType: 'service', entityId, version: Number(row['version'] ?? 0) },
      });
      expect(res.status(), await res.text()).toBe(200);
    } finally {
      await context.close();
    }
  }

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: authFile('admin') });
    const page = await context.newPage();
    const res = await page.request.get(
      `/api/admin/entity-seo/list?type=service&limit=100&q=${SLUG}`,
    );
    expect(res.status()).toBe(200);
    const rows = ((await res.json()) as { data: { rows: Record<string, unknown>[] } }).data.rows;
    const row = rows.find((r) => r['slug'] === SLUG);
    expect(row, `the seeded service ${SLUG}`).toBeTruthy();
    entityId = String(row!['entityId']);
    label = String(row!['label']);
    await context.close();
    await restore(browser);
  });

  test.afterAll(async ({ browser }) => {
    await restore(browser);
  });

  test('a title in both languages, a share image and Index off reach the public head', async ({
    page,
    request,
  }) => {
    // The panel reads its row once per opening. The list refreshing after the save re-renders
    // the drawer's host, and must not read the row again: that answer resets the form, which
    // cleared "Saved" (and anything typed since) before SeoPanel keyed its fields on words.
    let rowReads = 0;
    let saveSent = false;
    let relisted = 0;
    page.on('request', (req) => {
      if (new URL(req.url()).pathname !== '/api/admin/entity-seo') return;
      if (req.method() === 'GET') rowReads += 1;
      if (req.method() === 'PUT') saveSent = true;
    });
    page.on('requestfinished', (req) => {
      if (saveSent && new URL(req.url()).pathname === '/api/admin/entity-seo/list') relisted += 1;
    });

    await page.goto('/admin/seo?tab=pages&type=service');
    await ready(page);
    await page.getByLabel('Search services').fill(SLUG);
    await expect(page.getByRole('button', { name: `Edit SEO for ${label}` })).toHaveCount(1);
    await press(page, `Edit SEO for ${label}`);
    const drawer = page.getByRole('dialog', { name: `SEO: ${label}` });
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('.save-status')).toHaveCount(1);

    await drawer
      .getByRole('group', { name: 'Editing language' })
      .getByRole('radio', { name: 'Both' })
      .check();
    await drawer.locator('#f-metaTitle-en').fill(TITLE.en);
    await drawer.locator('#f-metaTitle-ar').fill(TITLE.ar);
    // The counters follow, and both previews show the words as typed.
    await expect(drawer).toContainText(`${TITLE.en.length}/120`);
    await expect(drawer.getByRole('region', { name: 'Google preview', exact: true })).toContainText(
      TITLE.en,
    );
    await expect(drawer.getByRole('region', { name: 'Google preview in Arabic' })).toContainText(
      TITLE.ar,
    );

    // A share image from the library.
    const image = drawer.getByRole('group', { name: 'Social share image' });
    await image.getByRole('button', { name: /^(Choose|Change)…$/ }).click();
    const picker = page.getByRole('dialog', { name: 'Social share image: choose' });
    await expect(picker).toBeVisible();
    await picker.getByLabel('Search media').fill('head wrap');
    await picker.getByRole('button', { name: new RegExp(`^${STILL}`) }).click();
    await picker.getByRole('button', { name: 'Use image' }).click();
    await expect(picker).toBeHidden();
    await expect(image).toContainText(STILL);

    // Index off asks first.
    const index = drawer.getByRole('switch', { name: 'Let search engines index this page' });
    await expect(index).toHaveAttribute('aria-checked', 'true');
    await index.click();
    const confirm = page.getByRole('dialog', { name: 'Hide this page from search engines?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Hide from search' }).click();
    await expect(index).toHaveAttribute('aria-checked', 'false');

    await drawer.getByRole('button', { name: 'Save SEO' }).click();
    await expect(drawer.locator('.save-status')).toHaveText(/^Saved/);
    // The list has its fresh answer, and the panel still says Saved, from its one read.
    await expect.poll(() => relisted).toBeGreaterThan(0);
    await expect(drawer.locator('.save-status')).toHaveText(/^Saved/);
    expect(rowReads, 'reads of the SEO row while the drawer was open').toBe(1);
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    const row = page.getByRole('row', { name: new RegExp(label) });
    await expect(row).toContainText('Custom');
    await expect(row).toContainText('Hidden');

    // The public twins: the title, the share image (absolute, a JPEG, on this origin), noindex.
    const origin = new URL(page.url()).origin;
    for (const [path, title] of [
      [`/services/${SLUG}`, TITLE.en],
      [`/ar/services/${SLUG}`, TITLE.ar],
    ] as const) {
      const html = await (await request.get(path)).text();
      expect(html, path).toMatch(new RegExp(`<title>[^<]*${title}[^<]*</title>`));
      expect(html, path).toMatch(/<meta name="robots" content="noindex[^"]*"/);
      const og = /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1] ?? '';
      expect(og.startsWith(`${origin}/`), `${path} og:image ${og}`).toBe(true);
      expect(og, path).toMatch(/jpe?g/);
    }
    const sitemap = await (await request.get('/sitemap.xml')).text();
    expect(sitemap).not.toContain(`/services/${SLUG}</loc>`);
  });

  test('a second editor’s save is refused with "Reload their version"', async ({ browser }) => {
    const context = await browser.newContext({ storageState: authFile('admin') });
    try {
      const open = async () => {
        const page = await context.newPage();
        await page.goto('/admin/seo?tab=pages&type=service');
        await ready(page);
        await page.getByLabel('Search services').fill(SLUG);
        await expect(page.getByRole('button', { name: `Edit SEO for ${label}` })).toHaveCount(1);
        await press(page, `Edit SEO for ${label}`);
        const drawer = page.getByRole('dialog', { name: `SEO: ${label}` });
        await expect(drawer.locator('#f-metaTitle-en')).toHaveValue(TITLE.en);
        return drawer;
      };
      const first = await open();
      const second = await open();
      await first.locator('#f-metaTitle-en').fill(`${TITLE.en}, first`);
      await first.getByRole('button', { name: 'Save SEO' }).click();
      await expect(first.locator('.save-status')).toHaveText(/^Saved/);
      await second.locator('#f-metaTitle-en').fill(`${TITLE.en}, second`);
      await second.getByRole('button', { name: 'Save SEO' }).click();
      await expect(second.getByRole('button', { name: 'Reload their version' })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('put back, the page is in the sitemap again', async ({ browser, request }) => {
    await restore(browser);
    const sitemap = await (await request.get('/sitemap.xml')).text();
    expect(sitemap).toContain(`/services/${SLUG}</loc>`);
    const html = await (await request.get(`/services/${SLUG}`)).text();
    expect(html).not.toMatch(/<meta name="robots" content="noindex/);
  });
});

test.describe('the Redirects tab', () => {
  test.use({ storageState: authFile('seo'), contextOptions: { reducedMotion: 'reduce' } });

  test('/admin/redirects answers on the tab; a rule is created, edited and deleted in the drawer', async ({
    page,
  }) => {
    await page.goto('/admin/redirects');
    await expect(page).toHaveURL(/\/admin\/seo\?tab=redirects$/);
    await ready(page);
    await expect(page.getByRole('button', { name: 'Sync to edge' })).toBeVisible();

    const from = `/e2e-u10-${Date.now().toString(36)}`;
    await page.getByRole('button', { name: 'New redirect' }).click();
    const created = page.getByRole('dialog', { name: 'New redirect' });
    await expect(created).toBeVisible();
    await created.locator('#f-sourcePath').fill(from);
    await created.locator('#f-targetPath').fill('/services');
    await created.locator('#f-status').selectOption('302');
    await created.getByRole('button', { name: 'Create redirect' }).click();
    await expect(created).toBeHidden();

    await page.getByLabel('Search Redirects').fill(from);
    await expect(page.getByRole('link', { name: from })).toBeVisible();
    await press(page, `Edit ${from}`);
    const edit = page.getByRole('dialog', { name: 'Edit redirect' });
    await expect(edit.locator('#f-targetPath')).toHaveValue('/services');
    await edit.locator('#f-targetPath').fill('/contact');
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(edit).toBeHidden();
    await expect(page.getByRole('row', { name: new RegExp(from) })).toContainText('/contact');

    await press(page, `Delete ${from}`);
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('link', { name: from })).toHaveCount(0);
  });
});

test.describe('the Site wide tab', () => {
  test.use({ storageState: authFile('admin'), contextOptions: { reducedMotion: 'reduce' } });

  test('hiding the site asks for "noindex" typed; Cancel puts the value back (never saved)', async ({
    page,
  }) => {
    await page.goto('/admin/seo?tab=site');
    await ready(page);
    const robots = page.locator('#f-robotsDirectives');
    await expect(robots).toHaveValue('index,follow');
    await robots.selectOption('noindex,follow');
    await page.getByRole('button', { name: 'Save site wide settings' }).click();
    const ask = page.getByRole('dialog', { name: 'Hide the whole site from search engines?' });
    await expect(ask).toBeVisible();
    await expect(ask).toContainText('This hides every page of the site from search engines.');
    const hide = ask.getByRole('button', { name: 'Hide the site' });
    await expect(hide).toBeDisabled();
    await ask.getByLabel('Type noindex to confirm').fill('noinde');
    await expect(hide).toBeDisabled();
    await ask.getByLabel('Type noindex to confirm').fill('noindex');
    await expect(hide).toBeEnabled();
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(ask).toBeHidden();
    await expect(robots).toHaveValue('index,follow');
  });
});
