import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { RELEASES_OFF_ONLY, SKIP_REASON, authFile, releasesOn, staffEnv } from './staff';

// The Header screen (Admin v2 E5), end to end through the real Worker, session and database:
// Admin saves the header's options through the screen (a large logo, the links beside the
// language switch, a button) and the public pages render them server-side, in both
// languages; a see-through bar with too light a tint is refused; Content Creator sees the menu
// card and not the options (and the options API refuses it); Developer the options and not the
// menu card. Everything is put back: the row is removed, which is the header as built, byte for
// byte (tests/render/siteChrome.spec.ts).
//
// Its own project (playwright.config.ts `header`), after `general`: it changes the header every
// public spec reads, served-html's bytes and the layout-shift measurements included.

test.skip(!staffEnv(), SKIP_REASON);
// The release-mode rehearsal (Admin v2 R14-prep): written for releases off.
test.skip(releasesOn(), RELEASES_OFF_ONLY);
test.describe.configure({ mode: 'serial' });

const API = '/api/admin/site-appearance';
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

type Row = Record<string, unknown> & { version: number };

function service() {
  const env = staffEnv()!;
  return createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function csrf(page: Page): Promise<string> {
  if (!page.url().includes('/admin')) await page.goto('/admin', { waitUntil: 'networkidle' });
  const token = await page.locator('meta[name="csrf-token"]').getAttribute('content');
  expect(token, 'the admin layout carries a CSRF token').toBeTruthy();
  return token!;
}

async function read(page: Page): Promise<Row> {
  const res = await page.request.get(API);
  expect(res.status(), `GET ${API}`).toBe(200);
  return ((await res.json()) as { data: Row }).data;
}

/** The opening <header> tag of a public page, as served. */
async function headerTag(page: Page, path: string): Promise<string> {
  const html = await (await page.request.get(path)).text();
  return /<header\b[^>]*class="site-header[^"]*"[^>]*>/.exec(html)?.[0] ?? '';
}

let tenant: string | null = null;

test.afterAll(async () => {
  if (!staffEnv()) return;
  // No row is the header as built: remove what this run saved (the service role, outside any
  // release; releases are off for this spec).
  if (tenant) await service().from('site_appearance').delete().eq('tenant_id', tenant);
});

test.describe('as admin', () => {
  test.use({ storageState: authFile('admin'), contextOptions: { reducedMotion: 'reduce' } });

  test('the screen saves the options; zero axe violations', async ({ page }) => {
    await page.goto('/admin/appearance/header', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 1, name: 'Header' })).toBeVisible();
    for (const name of ['Menu items', 'Layout', 'Behaviour', 'Button', 'Preview']) {
      await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
    }
    // The defaults: no button, so the sketches show none.
    await expect(page.locator('.hdr-pv__cta')).toHaveCount(0);
    const axe = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual(
      [],
    );

    await page.locator('#f-logoSize').selectOption('l');
    await page.locator('#f-menuAlign').selectOption('end');
    await page.locator('#f-ctaShow').click();
    await expect(page.locator('#f-ctaShow')).toHaveAttribute('aria-checked', 'true');
    await page
      .locator('form', { has: page.locator('#f-ctaHref') })
      .getByRole('group', { name: 'Editing language' })
      .getByRole('radio', { name: 'Both' })
      .check();
    await page.locator('#f-ctaLabel-en').fill('Start a project');
    await page.locator('#f-ctaLabel-ar').fill('ابدأ مشروعك');
    await page.locator('#f-ctaHref').fill('/contact#inquiry');
    // The sketches follow the form before it is saved.
    await expect(page.locator('.hdr-pv__bar[data-logo="l"]')).toHaveCount(2);
    await expect(page.locator('.hdr-pv__cta').first()).toHaveText('Start a project');

    await page.getByRole('button', { name: 'Save the header' }).click();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: /Saved at \d\d:\d\d/ })
        .first(),
    ).toBeVisible();
    const row = await read(page);
    tenant = String(row['tenant_id']);
    expect(row).toMatchObject({
      header_logo_size: 'l',
      header_menu_align: 'end',
      header_cta_show: true,
      header_cta_label: { en: 'Start a project', ar: 'ابدأ مشروعك' },
      header_cta_href: '/contact#inquiry',
      header_tint: 'none',
    });
  });

  test('the public pages render the saved header, server-side, in both languages', async ({
    page,
  }) => {
    const en = await headerTag(page, '/about');
    expect(en).toContain('data-logo="l"');
    expect(en).toContain('data-align="end"');
    expect(en).not.toContain('style=');
    const html = await (await page.request.get('/about')).text();
    expect(html).toMatch(
      /<a class="site-header__cta" href="\/contact#inquiry"[^>]*>Start a project<\/a>/,
    );
    expect(html).toContain('sizes="clamp(96px, 12vw, 160px)"');
    // The language switch is still there (O-13), beside the button.
    expect(html).toMatch(/<div class="site-header__end">[\s\S]*?class="site-header__lang"/);
    const ar = await (await page.request.get('/ar/about')).text();
    expect(ar).toMatch(
      /<a class="site-header__cta" href="\/ar\/contact#inquiry"[^>]*>ابدأ مشروعك<\/a>/,
    );

    // The large preset reaches the root, so the bar and every offset built on it follow.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/about');
    const logoW = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bs-logo-w').trim(),
    );
    expect(logoW).toBe('clamp(96px, 12vw, 160px)');
    await expect(page.locator('a.site-header__cta')).toBeVisible();
  });

  test('a sticky bar that stays see-through after the hero needs the darkest tint (422)', async ({
    page,
  }) => {
    const row = await read(page);
    const refused = await page.request.patch(API, {
      headers: { 'x-csrf-token': await csrf(page), origin: new URL(page.url()).origin },
      data: { sticky: true, solidAfterHero: false, tint: 'medium', version: row.version },
    });
    expect(refused.status(), await refused.text()).toBe(422);
    const taken = await page.request.patch(API, {
      headers: { 'x-csrf-token': await csrf(page), origin: new URL(page.url()).origin },
      data: { sticky: true, solidAfterHero: false, tint: 'dark', version: row.version },
    });
    expect(taken.status(), await taken.text()).toBe(200);
    const tag = await headerTag(page, '/about');
    expect(tag).toContain('data-solid="off"');
    expect(tag).toContain('data-tint="dark"');
  });
});

test.describe('as content creator', () => {
  test.use({ storageState: authFile('content_creator') });

  test('sees the menu card and not the options, which the API refuses', async ({ page }) => {
    await page.goto('/admin/appearance/header', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 2, name: 'Menu items' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Layout', exact: true })).toHaveCount(
      0,
    );
    expect((await page.request.get(API)).status()).toBe(403);
  });
});

test.describe('as developer', () => {
  test.use({ storageState: authFile('developer') });

  test('sees the options and not the menu card', async ({ page }) => {
    await page.goto('/admin/appearance/header', { waitUntil: 'networkidle' });
    await expect(
      page.getByRole('heading', { level: 2, name: 'Layout', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Menu items' })).toHaveCount(0);
  });
});
