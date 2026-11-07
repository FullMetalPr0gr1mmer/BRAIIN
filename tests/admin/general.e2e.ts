import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';
import { encodeMediaMeta, MEDIA_META_HEADER } from '@schemas/media';
import { CONFLICT_WORDS } from '@/lib/admin/entitySave';
import { discardDrafts, publishOwn, savedPattern, withDraft } from './releaseSteps';
import { SKIP_REASON, authFile, releasesOn, staffEnv } from './staff';

// General settings v2 (Admin v2 U9), end to end through the real Worker, session and database:
// Admin saves the identity through the screen (a tagline, a social account hidden, a map link)
// and the studio's zone; Developer saves through the API; the public home page then shows no
// hidden account and its Organization JSON-LD carries the slogan and hasMap; a square upload
// set as the favicon and the app icon puts the icon links and the manifest link in the head,
// and `/_image` answers each as PNG; Developer sees the applications switch off with the
// reason; a second tab's save is a 409. Everything is put back as it was.
//
// Its own project (playwright.config.ts `general`), after the public and admin specs and page
// visibility: it changes the public identity every other spec reads, served-html's bytes
// included.
//
// Both modes (Admin v2 R14b). With releases on the identity is staged: a save names the pending
// change (releaseSteps.ts `withDraft`), the screen says "Saved as an unpublished change", and
// the spec publishes its own identity change before each public check (`publishOwn`). The
// studio's zone is a technical setting, immediate in both modes. Cleanup throws the identity's
// unclaimed pending change away as the system first, then writes the identity back.

test.skip(!staffEnv(), SKIP_REASON);
test.describe.configure({ mode: 'serial' });

const IDENTITY = [{ entityType: 'site_profile' }] as const;

const PROFILE = '/api/admin/site-profile';
const SETTINGS = '/api/admin/settings';
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

type Row = Record<string, unknown> & { version: number };

async function csrf(page: Page): Promise<string> {
  if (!page.url().includes('/admin')) await page.goto('/admin', { waitUntil: 'networkidle' });
  const token = await page.locator('meta[name="csrf-token"]').getAttribute('content');
  expect(token, 'the admin layout carries a CSRF token').toBeTruthy();
  return token!;
}

async function read(page: Page, url: string): Promise<Row> {
  const res = await page.request.get(url);
  expect(res.status(), `GET ${url}`).toBe(200);
  return ((await res.json()) as { data: Row }).data;
}

async function save(page: Page, url: string, data: Record<string, unknown>, status = 200) {
  const res = await page.request.patch(url, {
    headers: { 'x-csrf-token': await csrf(page), origin: new URL(page.url()).origin },
    data,
  });
  expect(res.status(), `PATCH ${url}: ${await res.text()}`).toBe(status);
  return res;
}

/**
 * Saves the identity on top of what is stored (with releases on, naming its pending change),
 * then, with releases on, publishes this spec's identity change so the public site has it.
 */
async function saveIdentity(page: Page, values: Record<string, unknown>) {
  const row = await read(page, PROFILE);
  await save(page, PROFILE, withDraft(row, values));
  await publishOwn(page, IDENTITY, 0);
}

/** The identity as the form would send it back (the keys the restore needs). */
function profileBody(row: Row): Record<string, unknown> {
  return {
    tagline: row['tagline'] ?? null,
    mapUrl: row['map_url'] ?? null,
    phoneE164: row['phone_e164'] ?? null,
    phoneDisplay: row['phone_display'] ?? null,
    faviconMediaId: row['favicon_media_id'] ?? null,
    appIconMediaId: row['app_icon_media_id'] ?? null,
    // The second tab's save changes it (R14d), and with releases off that change is live.
    foundedYear: row['founded_year'] ?? null,
    socials: row['socials'],
    version: row.version,
  };
}

let original: Row;
let originalZone = 'Asia/Riyadh';

test.describe('as admin', () => {
  test.use({ storageState: authFile('admin'), contextOptions: { reducedMotion: 'reduce' } });

  test.beforeAll(async ({ browser }) => {
    // Releases on: start from the live identity, with no pending change of an earlier run.
    await discardDrafts(IDENTITY);
    const context = await browser.newContext({ storageState: authFile('admin') });
    const page = await context.newPage();
    original = await read(page, PROFILE);
    originalZone = String((await read(page, SETTINGS))['timezone'] ?? 'Asia/Riyadh');
    await context.close();
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: authFile('admin') });
    const page = await context.newPage();
    await page.goto('/admin', { waitUntil: 'networkidle' });
    // Releases on: the spec's own pending identity change goes first (as the system), so the
    // write-back below starts from live and is published alone.
    await discardDrafts(IDENTITY);
    await saveIdentity(page, profileBody(original));
    const settings = await read(page, SETTINGS);
    await save(page, SETTINGS, { timezone: originalZone, version: settings.version });
    await context.close();
  });

  test('the screen saves the identity and the zone; zero axe violations', async ({ page }) => {
    await page.goto('/admin/settings', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 2, name: 'Site', exact: true })).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Contact', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Social accounts', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('The logo is part of the site build')).toBeVisible();
    const axe = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(axe.violations.map((v) => v.id)).toEqual([]);

    // The editor shows one language at a time, English first: Both shows every Arabic half,
    // as a person would switch it (the form's own "Editing language" control).
    await page
      .locator('form', { has: page.locator('#f-tagline-en') })
      .getByRole('group', { name: 'Editing language' })
      .getByRole('radio', { name: 'Both' })
      .check();
    await page.locator('#f-tagline-en').fill('From the brain to the real world');
    await page.locator('#f-tagline-ar').fill('من الفكرة إلى الواقع');
    await page.locator('#f-mapUrl').fill('https://maps.app.goo.gl/e2eStudio');
    // The second account: "Show on the site" off.
    const switches = page.locator('[id^="f-socials-"][id$="-visible"]');
    await switches.nth(1).click();
    await expect(switches.nth(1)).toHaveAttribute('aria-checked', 'false');
    await page.getByRole('button', { name: 'Save general settings' }).click();
    // "Saved at 14:05", or with releases on "Saved as an unpublished change at 14:05".
    await expect(
      page.getByRole('status').filter({ hasText: savedPattern() }).first(),
    ).toBeVisible();

    await page.locator('#f-timezone').selectOption('Asia/Dubai');
    await page.getByRole('button', { name: 'Save region and data' }).click();
    await expect.poll(async () => (await read(page, SETTINGS))['timezone']).toBe('Asia/Dubai');

    const row = await read(page, PROFILE);
    expect(row['tagline']).toEqual({
      en: 'From the brain to the real world',
      ar: 'من الفكرة إلى الواقع',
    });
    expect((row['socials'] as { visible?: boolean }[])[1]?.visible).toBe(false);
    // Releases on: the identity change waits; it goes live with this spec's own publish.
    await publishOwn(page, IDENTITY);
  });

  test('the admin clock follows the zone, with no hydration error', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto('/admin/users', { waitUntil: 'networkidle' });
    await expect(page.locator('html')).toHaveAttribute('data-studio-tz', 'Asia/Dubai');
    await page.goto('/admin/leads', { waitUntil: 'networkidle' });
    expect(errors).toEqual([]);
  });

  test('the public home: no hidden account, and the slogan and the map in its JSON-LD', async ({
    page,
  }) => {
    const row = await read(page, PROFILE);
    const hidden = (row['socials'] as { url: string; visible?: boolean }[]).find(
      (s) => s.visible === false,
    );
    expect(hidden).toBeTruthy();
    const html = await (await page.request.get('/')).text();
    expect(html).not.toContain(`href="${hidden!.url}"`);
    const ld = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
      .map((m) => JSON.parse(m[1]!) as Record<string, unknown>)
      .find((node) => node['@type'] === 'Organization');
    expect(ld).toMatchObject({
      slogan: 'From the brain to the real world',
      hasMap: 'https://maps.app.goo.gl/e2eStudio',
    });
    expect(ld!['sameAs']).not.toContain(hidden!.url);
  });

  test('a square upload as the icons: the head links them, /_image answers PNG, the manifest lists them', async ({
    page,
  }) => {
    await page.goto('/admin', { waitUntil: 'networkidle' });
    const jpeg = await sharp({
      create: { width: 600, height: 600, channels: 3, background: { r: 0, g: 36, b: 188 } },
    })
      .jpeg({ quality: 80 })
      .toBuffer();
    const upload = await page.request.post('/api/admin/media/upload', {
      headers: {
        'x-csrf-token': await csrf(page),
        origin: new URL(page.url()).origin,
        'content-type': 'image/jpeg',
        [MEDIA_META_HEADER]: encodeMediaMeta({
          alt: { en: 'Site icon', ar: 'أيقونة الموقع' },
          tags: ['e2e'],
          displayName: 'icon-e2e.jpg',
        }),
      },
      data: jpeg,
    });
    expect(upload.status(), await upload.text()).toBe(200);
    const icon = ((await upload.json()) as { data: { id: string } }).data.id;

    // (A picture that is not square, or not an upload, is refused on its field by 0102's
    // trigger: supabase/tests/general_settings.test.sql and tests/lib/generalKit.spec.ts.)
    await saveIdentity(page, { faviconMediaId: icon, appIconMediaId: icon });

    const head = await (await page.request.get('/')).text();
    const links = [
      ...head.matchAll(/<link rel="icon" type="image\/png" sizes="(\d+)x\1" href="([^"]+)"/g),
    ];
    expect(links.map((m) => m[1])).toEqual(['32', '192']);
    for (const [, , href] of links) {
      const res = await page.request.get(href!.replace(/&amp;/g, '&'));
      expect(res.status(), href).toBe(200);
      expect(res.headers()['content-type']).toContain('image/png');
    }
    expect(head).toMatch(/<link rel="apple-touch-icon" sizes="180x180" href="\/_image\?/);
    expect(head).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(await (await page.request.get('/ar/')).text()).toContain(
      '<link rel="manifest" href="/ar/manifest.webmanifest">',
    );
    const manifest = (await (await page.request.get('/manifest.webmanifest')).json()) as {
      icons: { sizes: string }[];
      display: string;
    };
    expect(manifest.display).toBe('browser');
    expect(manifest.icons.map((i) => i.sizes)).toEqual(['192x192', '512x512']);
  });

  test('a second tab’s save is a 409, and the form keeps its work', async ({ page, browser }) => {
    await page.goto('/admin/settings', { waitUntil: 'networkidle' });
    await expect(page.locator('#f-mapUrl')).toBeVisible();
    const other = await browser.newContext({ storageState: authFile('admin') });
    const second = await other.newPage();
    await second.goto('/admin', { waitUntil: 'networkidle' });
    const row = await read(second, PROFILE);
    // A real change: a year the identity does not hold. A save equal to live changes nothing,
    // and with releases on it stages nothing either (stagedSingletonUpdate drops it), so it
    // would leave this form nothing to meet (R14d: the rehearsal's failure).
    const founded = row['founded_year'] === 2018 ? 2017 : 2018;
    const res = await save(second, PROFILE, withDraft(row, { foundedYear: founded }));
    const theirs = ((await res.json()) as { data: Row }).data;
    expect(theirs['founded_year']).toBe(founded);
    // With releases on, the other tab's save is the pending change this form never saw.
    if (releasesOn()) expect(theirs['draft'], 'the other tab left a pending change').toBeTruthy();
    await other.close();

    await page.locator('#f-mapUrl').fill('https://maps.app.goo.gl/e2eConflict');
    await page.getByRole('button', { name: 'Save general settings' }).click();
    // Releases off: the row moved on (409 `conflict`); on: a pending change the form did not
    // name (409 `draft-conflict`). The same banner, from the form's own words.
    await expect(page.getByRole('alert').filter({ hasText: CONFLICT_WORDS })).toBeVisible();
    await expect(page.locator('#f-mapUrl')).toHaveValue('https://maps.app.goo.gl/e2eConflict');
  });
});

test.describe('as developer', () => {
  test.use({ storageState: authFile('developer') });
  test.afterAll(async () => {
    if (staffEnv()) await discardDrafts(IDENTITY);
  });

  test('edits the identity, but the applications switch is off with the reason', async ({
    page,
  }) => {
    await page.goto('/admin/settings', { waitUntil: 'networkidle' });
    const toggle = page.getByRole('switch', { name: 'Accepting job applications' });
    await expect(toggle).toBeDisabled();
    await expect(page.getByText('Only an admin can open or close job applications.')).toBeVisible();
    const row = await read(page, PROFILE);
    await save(
      page,
      PROFILE,
      withDraft(row, { phoneE164: '+966500000009', phoneDisplay: '050 000 0009' }),
    );
    // Releases on: the read lays the Developer's pending change over live.
    const after = await read(page, PROFILE);
    expect(after['phone_e164']).toBe('+966500000009');
    // Back as it was: with releases on the change then equals live, so nothing stays pending.
    await save(page, PROFILE, withDraft(after, { phoneE164: null, phoneDisplay: null }));
    if (releasesOn()) {
      expect((await read(page, PROFILE))['draft']).toBeNull();
    }
    // The server refuses the switch for a Developer whatever the screen shows.
    const res = await page.request.patch('/api/admin/site-profile/intake', {
      headers: { 'x-csrf-token': await csrf(page), origin: new URL(page.url()).origin },
      data: { acceptingApplications: true },
    });
    expect(res.status()).toBe(403);
  });
});
