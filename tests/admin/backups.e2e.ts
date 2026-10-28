import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { Role } from '@/lib/auth/types';
import { RELEASES_OFF_ONLY, SKIP_REASON, authFile, releasesOn, staffEnv } from './staff';

/*
 * Release UX II (Admin v2 R13) in a real browser.
 *
 * Releases are OFF in CI, as in production until R14 (`app.release_tenants` is empty), so:
 *   - Backups & versions (/admin/backups) says so for every CMS role, reads no version and
 *     loads no script of its own; Admin and Developer get "Download content" (export.backup),
 *     Content Creator and SEO the line that says who can; the hourly limit's notice reads
 *     back; axe clean and no sideways scroll at 320, 390 and 1280. Sales is refused by the
 *     page itself (tests/admin/refusals.e2e.ts, LOCKED_SCREENS).
 *   - the content export the link follows answers a file to a Developer, and refuses a link
 *     from another site before anything is spent;
 *   - the history drawer opens from a service's editor (Admin, and SEO, which reads the
 *     service), lists the saves that went live, says restoring needs releases, offers no
 *     Restore, and asks for nothing before it is opened;
 *   - the versions list and the dashboard's publish card, drawn only with releases on, are
 *     driven on the kit's Publishing card over made-up versions (src/components/admin/screens/
 *     versions/sample.ts): Restore and its toast, Change time, Unschedule, the card's rows.
 * The release-mode versions page on real releases is R14's e2e (as R10's and R12's).
 */

test.skip(!staffEnv(), SKIP_REASON);
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const CMS: readonly Role[] = ['admin', 'content_creator', 'seo', 'developer'];
const EXPORTERS: readonly Role[] = ['admin', 'developer'];

async function open(page: Page, path: string) {
  const res = await page.goto(path, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  return res;
}

async function check(page: Page, where: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.help}`),
    where,
  ).toEqual([]);
  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over, `${where}: sideways scroll`).toBeLessThanOrEqual(0);
}

for (const role of CMS) {
  test.describe(`Backups & versions, releases off, as ${role}`, () => {
    test.use({ storageState: authFile(role) });
    // The release-mode rehearsal (Admin v2 R14-prep): releases-mode.e2e.ts drives the page on.
    test.skip(releasesOn(), RELEASES_OFF_ONLY);

    test('says publishing in releases is not on yet, and offers what exists', async ({ page }) => {
      const asked: string[] = [];
      page.on('request', (r) => {
        if (/\/api\/admin\/(releases|history|drafts)\b/.test(r.url())) asked.push(r.url());
      });
      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        const res = await open(page, '/admin/backups');
        expect(res?.status()).toBe(200);
        await expect(
          page.getByRole('heading', { level: 1, name: 'Backups & versions' }),
        ).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Versions', exact: true })).toBeVisible();
        await expect(page.getByText('Not switched on yet')).toBeVisible();
        await expect(
          page.getByText(/Publishing in releases isn’t switched on yet, so there are no versions/),
        ).toBeVisible();
        // No version exists, so the list's island is not on the page.
        await expect(page.locator('astro-island[component-url*="AdminVersions"]')).toHaveCount(0);
        const download = page.getByRole('link', { name: 'Download content' });
        if (EXPORTERS.includes(role)) {
          await expect(download).toHaveAttribute('href', '/api/admin/export-backup');
        } else {
          await expect(download).toHaveCount(0);
          await expect(
            page.getByText('An Admin or a Developer can download a copy of the content.'),
          ).toBeVisible();
        }
        await expect(page.getByText(/Leads, job applications, consent records/)).toBeVisible();
        await check(page, `/admin/backups at ${width}`);
      }
      expect(asked).toEqual([]);
    });

    test('the hourly limit’s notice reads back on the page', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 900 });
      await open(page, '/admin/backups?export=limit');
      await expect(
        page.getByText('You can download three copies an hour. Try again later.'),
      ).toBeVisible();
      await check(page, '/admin/backups?export=limit');
    });
  });
}

test.describe('the content export behind Download content', () => {
  test.use({ storageState: authFile('developer') });

  test('a file for a Developer; a link from another site is refused before anything', async ({
    page,
  }) => {
    const away = await page.request.get('/api/admin/export-backup', {
      headers: { 'sec-fetch-site': 'cross-site', referer: 'https://evil.example/trap' },
    });
    expect(away.status()).toBe(403);
    const ours = await page.request.get('/api/admin/export-backup', {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(ours.status(), await ours.text()).toBe(200);
    expect(ours.headers()['content-disposition']).toMatch(/^attachment; filename="/);
    expect(ours.headers()['cache-control']).toContain('no-store');
    const body = (await ours.json()) as { data?: Record<string, unknown> };
    expect(Object.keys(body.data ?? {})).toContain('services');
    expect(Object.keys(body.data ?? {})).not.toContain('leads');
  });
});

async function serviceId(page: Page, slug: string): Promise<string> {
  const res = await page.request.get('/api/admin/services?limit=100');
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { data?: { rows?: unknown[] }; rows?: unknown[] };
  const rows = (body.data?.rows ?? body.rows ?? []) as { id: string; slug: string }[];
  const row = rows.find((r) => r.slug === slug);
  expect(row, `the seeded service "${slug}"`).toBeTruthy();
  return row!.id;
}

for (const role of ['admin', 'seo'] as const) {
  test.describe(`the history drawer on a service's editor, as ${role}`, () => {
    test.use({ storageState: authFile(role) });
    // The release-mode rehearsal (Admin v2 R14-prep): "no Restore while releases are off".
    test.skip(releasesOn(), RELEASES_OFF_ONLY);

    test('lists what went live, offers no Restore while releases are off, loads on first use', async ({
      page,
    }) => {
      const asked: string[] = [];
      page.on('request', (r) => {
        if (/\/api\/admin\/history\b/.test(r.url())) asked.push(r.url());
      });
      const id = await serviceId(page, 'logo');
      await page.setViewportSize({ width: 1280, height: 900 });
      await open(page, `/admin/services/${id}`);
      // Named for its record ("History of Logo Design"). As SEO the editor opens on the SEO tab,
      // its form hidden: History follows the panel there (review R13-C1). The panel's own search
      // settings have their History too once a row exists ("History of Search settings for
      // Logo Design", R14-prep), so the service's is the one that does not name them.
      const history = page.getByRole('button', { name: /^History of (?!Search settings for )/ });
      await expect(history).toBeVisible();
      expect(asked).toEqual([]);

      await history.click();
      const drawer = page.getByRole('dialog', { name: /^History: / });
      await expect(drawer).toBeVisible();
      await expect(
        drawer.getByText('Every version of this that went live, newest first.'),
      ).toBeVisible();
      await expect(
        drawer.getByText(/Publishing in releases isn’t switched on yet, so these are the saves/),
      ).toBeVisible();
      await expect.poll(() => asked.length).toBe(1);
      expect(asked[0]).toContain(`entityType=service&entityId=${id}`);
      // Every version is listed, newest first (the seed's insert at least); none is restorable.
      await expect(drawer.getByRole('list', { name: /^Versions of / })).toBeVisible();
      await expect(drawer.getByRole('button', { name: /^Restore/ })).toHaveCount(0);
      await check(page, 'the history drawer open');

      await page.keyboard.press('Escape');
      await expect(drawer).toBeHidden();
      await expect(history).toBeFocused();
    });
  });
}

for (const role of CMS) {
  test.describe(`the kit's versions list and publish card, as ${role}`, () => {
    test.use({ storageState: authFile(role) });

    test('the card’s rows; Restore, Change time and Unschedule over made-up versions', async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await open(page, '/admin/kit');
      const kit = page.locator('[data-kit="versions"]');
      await expect(kit).toBeVisible();

      // The publish card (releases.md §7), over the sample status.
      const card = kit.locator('.pubcard');
      await expect(card.locator('.stat-row dd').first()).toContainText('v3');
      await expect(card.getByText(/^Published .* by Sample Publisher: Spring copy/)).toBeVisible();
      await expect(card.getByText('2 yours to publish · 1 waiting')).toBeVisible();
      await expect(card.getByText('Couldn’t refresh')).toBeVisible();
      await expect(card.getByRole('button', { name: 'Publish now' })).toBeVisible();
      await expect(card.getByRole('link', { name: /^Manage/ })).toHaveAttribute(
        'href',
        '/admin/backups',
      );

      // The versions list: the live one marked, never restored; an older one restored.
      const list = kit.getByRole('list', { name: 'Published versions' });
      await expect(list.getByText('Live now')).toBeVisible();
      await expect(list.getByRole('button', { name: 'Restore v3' })).toHaveCount(0);
      await expect(list.getByRole('button', { name: 'Publish v2 again' })).toBeVisible();
      await check(page, '/admin/kit with the versions list');

      await list.getByRole('button', { name: 'Restore v1' }).click();
      const confirm = page.getByRole('dialog').filter({ hasText: 'Restore v1?' });
      await expect(confirm).toBeVisible();
      await confirm.getByRole('button', { name: 'Restore' }).click();
      await expect(
        page.locator('#admin-toasts .toast', { hasText: 'v1 restored. Publish to make it live.' }),
      ).toBeVisible();
      await expect(list.getByRole('button', { name: 'Publish v1 again' })).toBeVisible();

      // A scheduled release: Change time on the studio's clock, then Unschedule.
      const upcoming = kit.getByRole('list', { name: 'Scheduled and failed releases' });
      await upcoming.getByRole('button', { name: 'Change time' }).click();
      const move = page.getByRole('dialog', { name: 'Change time' });
      await expect(move).toBeVisible();
      await expect(move.getByLabel('Day')).not.toHaveValue('');
      await check(page, 'the Change time dialog');
      await move.getByRole('button', { name: 'Change time' }).click();
      await expect(
        page.locator('#admin-toasts .toast', { hasText: 'The release’s time was changed.' }),
      ).toBeVisible();
      await upcoming.getByRole('button', { name: 'Unschedule' }).click();
      const sure = page.getByRole('dialog').filter({ hasText: 'Unschedule this release?' });
      await sure.getByRole('button', { name: 'Unschedule' }).click();
      await expect(
        page.locator('#admin-toasts .toast', {
          hasText: 'Unscheduled. Its changes are waiting to be published.',
        }),
      ).toBeVisible();
    });
  });
}
