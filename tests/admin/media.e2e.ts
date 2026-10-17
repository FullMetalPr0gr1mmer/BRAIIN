import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';
import { SKIP_REASON, authFile, staffEnv } from './staff';

/*
 * The media library and the picker with upload (Admin v2 U4), signed in, through the real
 * Worker, Images binding (wrangler dev's local one) and this job's local Supabase:
 *
 *   library   the seeded stills in the grid; a search in English and in Arabic; "Needs alt
 *             text"; the Videos tab; zero axe violations at 320, 390 and 1280 px with the
 *             grid, the upload dialog and the drawer open; the keyboard (Tab to the grid,
 *             arrows, Enter opens, Escape returns to the tile);
 *   upload    two JPEGs through "Choose images": Upload is refused until both are described
 *             in both languages, then both are sent and appear by name;
 *   drawer    a seeded still a published project uses: "Used in" links the project, Delete
 *             is off with the reason; an uploaded picture: its Arabic alt text saves and
 *             reloads, Replace file moves its version and its thumbnail, Download answers an
 *             attachment;
 *   roles     Content Creator and Developer see Upload and Replace, not Delete; SEO sees
 *             none of them and still saves a picture's words (the meta door);
 *   picker    a service's Poster: Choose, search, select and Use image; Upload in place
 *             chooses the new picture; leaving without saving keeps the stored poster.
 *
 * Uploaded rows are left in place (the per-role sweep opens the newest media row's edit
 * screen, U3's reason); deleting is covered by tests/lib/mediaUploadApi.spec.ts. Four upload
 * slots of the admin's and the content creator's daily 50 (eight with the CI retry).
 */

test.skip(!staffEnv(), SKIP_REASON);
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const VIEWPORTS = [320, 390, 1280];
/**
 * The seeded still the first published project uses as its poster (05-media-stills.json).
 * Opened through a search: with CI's uploads first, the 44 stills fill page 1 and this one can
 * sit on its last row or past it.
 */
const USED_STILL = 'A person in a black head wrap';

async function jpeg(width: number, height: number, tint: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: tint, g: 90, b: 160 } } })
    .jpeg({ quality: 80 })
    .toBuffer();
}

async function ready(page: Page) {
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  await page.waitForLoadState('networkidle');
}

async function openLibrary(page: Page, query = '') {
  await page.goto(`/admin/media${query}`, { waitUntil: 'networkidle' });
  await ready(page);
}

async function expectNoAxe(page: Page, label: string) {
  for (const width of VIEWPORTS) {
    await page.setViewportSize({ width, height: 900 });
    const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(
      violations.map((v) => `${v.id} [${v.impact ?? 'n/a'}] ${v.nodes.length}x: ${v.help}`),
      `${label} at ${width}px`,
    ).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${label} at ${width}px: no sideways scroll`).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

const grid = (page: Page) => page.getByRole('list', { name: 'Pictures' });
const tile = (page: Page, name: string | RegExp) =>
  grid(page).getByRole('button', {
    name: typeof name === 'string' ? new RegExp(`^${name}`) : name,
  });

async function search(page: Page, text: string) {
  const answered = page.waitForResponse(
    (res) =>
      res.url().includes('/api/admin/media/library') &&
      new URL(res.url()).searchParams.get('q') === text.trim(),
  );
  await page.getByLabel('Search media').fill(text);
  expect((await answered).status()).toBe(200);
  await page.waitForLoadState('networkidle');
}

test.describe('as admin', () => {
  test.use({ storageState: authFile('admin') });
  test.describe.configure({ mode: 'serial' });

  const stamp = Date.now().toString(36);
  const names = [`u4-dunes-${stamp}.jpg`, `u4-coast-${stamp}.jpg`];

  test('the library: search, the filter, the videos, axe and the keyboard', async ({ page }) => {
    await openLibrary(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Media library' })).toBeVisible();
    await expect(page.locator('.admin-header .admin-sub')).toContainText(
      'Images are resized and compressed automatically for every screen.',
    );
    // The seeded still may sit on any page once uploads land: the grid shows the newest first.
    await expect(grid(page).getByRole('button').first()).toBeVisible();
    await expect(page.getByText(/^Storage used: .+ of 1 GB$/)).toBeVisible();
    await expectNoAxe(page, 'the grid');

    // The keyboard: one Tab stop, arrows move, Enter opens, Escape returns to the tile.
    const first = grid(page).getByRole('button').first();
    await first.focus();
    await page.keyboard.press('ArrowRight');
    const second = grid(page).getByRole('button').nth(1);
    await expect(second).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/media\/[0-9a-f-]{36}/);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(second).toBeFocused();
    await expect(page).toHaveURL(/\/admin\/media$/);

    await search(page, 'head wrap');
    await expect(tile(page, USED_STILL)).toBeVisible();
    await expect(page.getByText(/^Showing 1 to \d+ of \d+$/)).toBeVisible();
    // Arabic, folded: no tashkeel typed, the stored text has some.
    await search(page, 'لثاما اسود');
    await expect(tile(page, USED_STILL)).toBeVisible();
    await search(page, 'zzzz-nothing');
    await expect(page.getByText('No pictures match "zzzz-nothing".')).toBeVisible();
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(grid(page).getByRole('button').first()).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/media$/);

    await page.getByRole('button', { name: 'Needs alt text' }).click();
    await expect(page.getByRole('button', { name: 'Needs alt text' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page).toHaveURL(/alt=missing/);
    await page.getByRole('button', { name: 'Needs alt text' }).click();

    await page.getByRole('group', { name: 'Show' }).getByText('Videos').click();
    await expect(page.getByRole('list', { name: 'Videos' })).toContainText('showreel.mp4');
    await expect(
      page.getByText('Videos are served from the site until video hosting is set up.'),
    ).toBeVisible();
    await expect(page).toHaveURL(/tab=videos/);
  });

  test('two pictures are described in both languages, then sent', async ({ page }) => {
    await openLibrary(page);
    await page.locator('.media-lib input[type="file"]').setInputFiles([
      { name: names[0]!, mimeType: 'image/jpeg', buffer: await jpeg(1200, 800, 40) },
      { name: names[1]!, mimeType: 'image/jpeg', buffer: await jpeg(900, 1200, 200) },
    ]);
    const dialog = page.getByRole('dialog', { name: 'Describe your images' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('1,200 by 800');
    const upload = dialog.getByRole('button', { name: 'Upload 2 pictures' });
    await expect(upload).toBeEnabled();
    await expectNoAxe(page, 'the upload dialog');

    // Nothing is sent until both languages are written for both.
    await upload.click();
    await expect(dialog.getByRole('alert').first()).toContainText('Alt text (English)');
    const en = dialog.getByLabel(/^Alt text \(English\)/);
    const ar = dialog.getByLabel(/^Alt text \(Arabic\)/);
    await en.nth(0).fill('Sand dunes at dusk, an e2e picture');
    await ar.nth(0).fill('كثبان رملية عند الغروب، صورة اختبار');
    await en.nth(1).fill('A rocky coast, an e2e picture');
    await ar.nth(1).fill('ساحل صخري، صورة اختبار');
    await upload.click();
    await expect(page.locator('#admin-toasts')).toContainText('2 pictures uploaded');
    await expect(dialog).toBeHidden();

    await search(page, stamp);
    await expect(tile(page, names[0]!)).toBeVisible();
    await expect(tile(page, names[1]!)).toBeVisible();
  });

  test('a used still: Used in links its project, Delete is off with the reason', async ({
    page,
  }) => {
    await openLibrary(page, '?q=head%20wrap');
    await tile(page, USED_STILL).click();
    const drawer = page.getByRole('dialog', { name: new RegExp(`^${USED_STILL}`) });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('link', { name: /^Project/ }).first()).toHaveAttribute(
      'href',
      /^\/admin\/portfolio\/[0-9a-f-]{36}$/,
    );
    await expect(drawer.getByRole('button', { name: 'Delete' })).toBeDisabled();
    await expect(drawer).toContainText('This file is in use. Remove it from those places first.');
    await expect(drawer.getByRole('link', { name: 'Download' })).toHaveCount(0); // a still
    await expectNoAxe(page, 'the drawer');
  });

  test('an uploaded picture: its words save, Replace moves it, Download answers a file', async ({
    page,
  }) => {
    page.on('dialog', (dialog) => void dialog.accept());
    await openLibrary(page, `?q=${stamp}`);
    await tile(page, names[0]!).click();
    const drawer = page.getByRole('dialog', { name: new RegExp(`^${names[0]}`) });
    await expect(drawer).toBeVisible();
    const id = /\/admin\/media\/([0-9a-f-]{36})/.exec(page.url())![1]!;

    await drawer
      .getByRole('group', { name: 'Editing language' })
      .getByRole('radio', { name: 'Both' })
      .check();
    await drawer.locator('#f-alt-ar').fill('كثبان عند الغروب، نص محدث');
    await drawer.getByRole('button', { name: 'Save changes' }).click();
    await expect(drawer.locator('.save-status')).toHaveText(/^Saved/);
    await page.goto(`/admin/media/${id}`, { waitUntil: 'networkidle' });
    await ready(page);
    const reopened = page.getByRole('dialog', { name: new RegExp(`^${names[0]}`) });
    await reopened
      .getByRole('group', { name: 'Editing language' })
      .getByRole('radio', { name: 'Both' })
      .check();
    await expect(reopened.locator('#f-alt-ar')).toHaveValue('كثبان عند الغروب، نص محدث');

    const before = (await (await page.request.get(`/api/admin/media/${id}`)).json()) as {
      data: { version: number; thumb_url: string };
    };
    const chooser = page.waitForEvent('filechooser');
    await reopened.getByRole('button', { name: 'Replace file' }).click();
    await (
      await chooser
    ).setFiles({
      name: `u4-replaced-${stamp}.jpg`,
      mimeType: 'image/jpeg',
      buffer: await jpeg(1000, 700, 120),
    });
    await reopened.getByRole('button', { name: 'Replace', exact: true }).click();
    await expect(page.locator('#admin-toasts')).toContainText('Picture replaced.');
    const after = (await (await page.request.get(`/api/admin/media/${id}`)).json()) as {
      data: { version: number; thumb_url: string };
    };
    expect(after.data.version).toBeGreaterThan(before.data.version);
    expect(after.data.thumb_url).not.toBe(before.data.thumb_url);

    const file = await page.request.get(`/api/admin/media/${id}/download`);
    expect(file.status()).toBe(200);
    expect(file.headers()['content-disposition'] ?? '').toMatch(/^attachment/);
  });
});

for (const role of ['content_creator', 'developer'] as const) {
  test.describe(`as ${role}`, () => {
    test.use({ storageState: authFile(role) });

    test('Upload and Replace, never Delete', async ({ page }) => {
      await openLibrary(page, '?q=head%20wrap');
      await expect(page.getByRole('link', { name: 'Upload' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Choose images' })).toBeVisible();
      await tile(page, USED_STILL).click();
      const drawer = page.getByRole('dialog', { name: new RegExp(`^${USED_STILL}`) });
      await expect(drawer.getByRole('button', { name: 'Replace file' })).toBeVisible();
      await expect(drawer.getByRole('button', { name: 'Delete' })).toHaveCount(0);
    });
  });
}

test.describe('as seo', () => {
  test.use({ storageState: authFile('seo') });

  test('no Upload, Replace or Delete; a picture’s words still save', async ({ page }) => {
    await openLibrary(page, '?q=head%20wrap');
    await expect(page.getByRole('link', { name: 'Upload' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Choose images' })).toHaveCount(0);
    await tile(page, USED_STILL).click();
    const drawer = page.getByRole('dialog', { name: new RegExp(`^${USED_STILL}`) });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Replace file' })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: 'Delete' })).toHaveCount(0);
    // Saving the words as they are: the meta door takes it (a new version, nothing changed).
    await expect(drawer.locator('#f-alt-en')).toHaveValue(/head wrap/);
    await drawer.getByRole('button', { name: 'Save changes' }).click();
    await expect(drawer.locator('.save-status')).toHaveText(/^Saved/);
  });
});

test.describe('the picker, as content_creator', () => {
  test.use({ storageState: authFile('content_creator') });

  test('Choose, Use image, and Upload in place; leaving keeps the stored poster', async ({
    page,
  }) => {
    page.on('dialog', (dialog) => void dialog.accept());
    const list = await page.request.get('/api/admin/services?limit=100');
    const body = (await list.json()) as { data?: { rows?: unknown[] } };
    const service = ((body.data?.rows ?? []) as { id: string; slug: string }[]).find(
      (r) => r.slug === 'brand-guidelines',
    );
    expect(service, 'the seeded service brand-guidelines').toBeTruthy();
    const stored = (await (
      await page.request.get(`/api/admin/services/${service!.id}`)
    ).json()) as {
      data: { poster_media_id: string | null };
    };

    await page.goto(`/admin/services/${service!.id}`, { waitUntil: 'networkidle' });
    await ready(page);
    const poster = page.getByRole('group', { name: 'Poster' });
    await poster.getByRole('button', { name: /^(Choose|Change)…$/ }).click();
    const picker = page.getByRole('dialog', { name: 'Poster: choose' });
    await expect(picker).toBeVisible();
    await picker.getByLabel('Search media').fill('head wrap');
    const still = picker.getByRole('button', { name: new RegExp(`^${USED_STILL}`) });
    await still.click();
    await expect(still).toHaveAttribute('aria-pressed', 'true');
    await picker.getByRole('button', { name: 'Use image' }).click();
    await expect(picker).toBeHidden();
    await expect(poster).toContainText(USED_STILL);

    // Upload in place: one file, described, sent, and chosen.
    await poster.getByRole('button', { name: 'Change…' }).click();
    await expect(picker).toBeVisible();
    const chooser = page.waitForEvent('filechooser');
    await picker.getByRole('button', { name: 'Upload', exact: true }).click();
    const name = `u4-picker-${Date.now().toString(36)}.jpg`;
    await (
      await chooser
    ).setFiles({
      name,
      mimeType: 'image/jpeg',
      buffer: await jpeg(800, 600, 90),
    });
    const describe = page.getByRole('dialog', { name: 'Describe your images' });
    await describe.getByLabel(/^Alt text \(English\)/).fill('A picker e2e picture');
    await describe.getByLabel(/^Alt text \(Arabic\)/).fill('صورة اختبار من المنتقي');
    await describe.getByRole('button', { name: 'Upload picture' }).click();
    await expect(describe).toBeHidden();
    await expect(picker).toBeHidden();
    await expect(poster).toContainText(name);

    // Leaving without saving: the stored poster is unchanged.
    await page.reload({ waitUntil: 'networkidle' });
    const now = (await (await page.request.get(`/api/admin/services/${service!.id}`)).json()) as {
      data: { poster_media_id: string | null };
    };
    expect(now.data.poster_media_id).toBe(stored.data.poster_media_id);
  });
});

test('/admin/media/new is a 302 to the library with Choose images in focus', async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: authFile('admin') });
  const page = await context.newPage();
  const res = await page.request.get('/admin/media/new', { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  expect(res.headers()['location']).toBe('/admin/media?upload=1');
  await page.goto('/admin/media/new', { waitUntil: 'networkidle' });
  await ready(page);
  await expect(page.getByRole('button', { name: 'Choose images' })).toBeFocused();
  await expect(page).toHaveURL(/\/admin\/media$/);
  await context.close();
});
