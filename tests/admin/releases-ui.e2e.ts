import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { Role } from '@/lib/auth/types';
import {
  buildRows,
  savebarCounts,
  savebarLead,
  selectedRows,
  type SavebarCounts,
} from '@/components/admin/screens/release/model';
import { sampleReleaseApi } from '@/components/admin/screens/release/sampleApi';
import {
  RELEASES_OFF_ONLY,
  SKIP_REASON,
  STAFF_ROLES,
  authFile,
  releasesOn,
  staffEnv,
} from './staff';

// Release UX I (Admin v2 R12) in a real browser, for every role.
//
// Releases are OFF in CI, as in production until R14 (`app.release_tenants` is empty), so the
// first half proves what that means for each role: no admin screen draws the savebar or asks
// for the pending changes, no list or editor marks a pending change, an editor saves live
// (its status is the select, not the release-mode switch), and the release reads answer
// every CMS role and refuse Sales.
//
// The second half drives the savebar and the publish dialog themselves, as each CMS role sees
// them, on the kit's Publishing card (/admin/kit): the same components over made-up changes
// (src/components/admin/screens/release/sampleApi.ts, who may publish what from ROLE_CAPS),
// so the counts, the waiting rows, a conflict's Compare and Keep my version, a dependency, the
// publish and its toast, Discard my changes, Escape and axe with the dialog open are proven
// before R14 switches releases on. Sales gets no card. The release mode of the editors and the
// lists themselves needs releases on, which is R14's e2e (as-built R12).

test.skip(!staffEnv(), SKIP_REASON);
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const CMS: readonly Role[] = ['admin', 'content_creator', 'seo', 'developer'];

async function open(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
}

/** What the kit's sample changes count for this role (the model the bar draws with). */
async function expected(role: Role): Promise<SavebarCounts> {
  return savebarCounts(buildRows((await sampleReleaseApi(role).pending()).items));
}

/**
 * A list each role opens, and (for a role that has one) whether it opens a service's editor,
 * which it saves live.
 */
const SCREENS: Readonly<Record<Role, { list: string; editor: boolean }>> = {
  admin: { list: '/admin/services', editor: true },
  content_creator: { list: '/admin/services', editor: true },
  seo: { list: '/admin/seo', editor: false },
  developer: { list: '/admin/settings', editor: false },
  sales: { list: '/admin/leads', editor: false },
};

/**
 * A real service's editor address. Since U5 + U6 the Services overview lists disciplines (a
 * service links from it only while it is filed under none); each discipline's own page links
 * its services' editors. So: the overview's disciplines in order, the first whose page lists a
 * service.
 */
async function firstServiceEditor(page: Page): Promise<string> {
  await open(page, '/admin/services');
  // Both screens read their rows after they mount: wait for the list, not just the network.
  const list = page.getByRole('list', { name: 'Disciplines' });
  await expect(list).toBeVisible();
  const disciplines = await list
    .locator('a.li__t[href^="/admin/disciplines/"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
  expect(disciplines.length).toBeGreaterThan(0);
  for (const href of disciplines) {
    await open(page, href);
    const own = page.locator('.svc-d__main');
    await expect(own.getByText('Loading…')).toHaveCount(0);
    const services = own.locator('a.li__t[href^="/admin/services/"]');
    if ((await services.count()) > 0) {
      const editor = await services.first().getAttribute('href');
      if (editor) return editor;
    }
  }
  throw new Error('No discipline lists a service.');
}

for (const role of STAFF_ROLES) {
  test.describe(`releases off, as ${role}`, () => {
    test.use({ storageState: authFile(role) });
    // The release-mode rehearsal (Admin v2 R14-prep): this half is what releases off looks like.
    test.skip(releasesOn(), RELEASES_OFF_ONLY);

    test('no screen draws the savebar, asks for pending changes or marks one', async ({ page }) => {
      const asked: string[] = [];
      page.on('request', (request) => {
        const url = request.url();
        if (/\/api\/admin\/(releases|drafts)\b/.test(url)) asked.push(url);
      });
      for (const path of ['/admin', SCREENS[role].list]) {
        await open(page, path);
        await expect(page.locator('.savebar'), path).toHaveCount(0);
        await expect(page.locator('astro-island[component-url*="AdminSavebar"]'), path).toHaveCount(
          0,
        );
        await expect(page.locator('.draft-note, .badge--pending'), path).toHaveCount(0);
      }
      // Nothing on these screens reads the release endpoints while releases are off.
      expect(asked).toEqual([]);
    });

    if (SCREENS[role].editor) {
      test('an editor saves live: the status select, the schedule, no release notice', async ({
        page,
      }) => {
        const href = await firstServiceEditor(page);
        expect(href).toMatch(/^\/admin\/services\/[0-9a-f-]{36}$/);
        await open(page, href);
        // The record's own form (the case study's and the SEO tab's panels are other forms,
        // mounted once opened).
        const form = page.locator('form.editor').first();
        await expect(form).toBeAttached();
        // Every field tab is mounted (U8), so these are in the form whichever tab is shown:
        // the Publishing tab's status select and per-item schedule, which release mode
        // replaces with the "Visible on the site" switch and drops (EditorForm, R12).
        await expect(form.locator('select#f-status')).toHaveCount(1);
        await expect(form.locator('input#f-scheduledFor[type="datetime-local"]')).toHaveCount(1);
        await expect(form.getByText('Visible on the site')).toHaveCount(0);
        await expect(page.locator('.draft-note')).toHaveCount(0);
        await expect(form.getByText(/^Version \d+$/)).toHaveCount(1);
      });
    }

    test('the release reads answer every CMS role and refuse Sales', async ({ page }) => {
      await open(page, '/admin');
      const pending = await page.request.get('/api/admin/releases/pending');
      const compare = await page.request.get(
        '/api/admin/drafts/00000000-0000-4000-8000-000000000999/compare',
      );
      if (role === 'sales') {
        expect(pending.status(), await pending.text()).toBe(403);
        expect(compare.status(), await compare.text()).toBe(403);
      } else {
        expect(pending.status(), await pending.text()).toBe(200);
        const body = (await pending.json()) as { data?: { items?: unknown }; items?: unknown };
        expect(Array.isArray((body.data ?? body).items)).toBe(true);
        // No such change: the gate let the role in, the change itself is not there.
        expect(compare.status(), await compare.text()).toBe(404);
      }
    });
  });
}

test.describe('the kit for Sales', () => {
  test.use({ storageState: authFile('sales') });

  test('draws no Publishing card', async ({ page }) => {
    await open(page, '/admin/kit');
    await expect(page.locator('[data-kit="publishing"]')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Unpublished changes' })).toHaveCount(0);
  });
});

for (const role of CMS) {
  test.describe(`the Publishing card, as ${role}`, () => {
    test.use({ storageState: authFile(role) });

    test('the bar counts what the role may publish; the dialog lists what waits; it publishes', async ({
      page,
    }) => {
      const counts = await expected(role);
      await open(page, '/admin/kit');
      const card = page.locator('[data-kit="publishing"]');
      const bar = card.getByRole('region', { name: 'Unpublished changes' });
      await expect(bar.locator('.savebar__lead')).toHaveText(savebarLead(counts));

      // Every CMS role may publish one of the samples at least (who may is ROLE_CAPS's).
      expect(counts.publishable).toBeGreaterThan(0);
      await bar.getByRole('button', { name: 'Publish…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Publish to the website' });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('.pub__row[data-state="waiting"]')).toHaveCount(counts.waiting);
      for (const row of await dialog.locator('.pub__row[data-state="waiting"]').all()) {
        await expect(row.locator('input[type="checkbox"]')).toHaveCount(0);
        await expect(row.locator('.pub__status')).toHaveText(/^Needs /);
      }
      const axe = await new AxeBuilder({ page }).withTags(WCAG).analyze();
      expect(axe.violations, JSON.stringify(axe.violations, null, 2)).toEqual([]);

      const publish = dialog.getByRole('button', { name: /^Publish \d+ changes?$/ });
      // The home hero is the change the live site moved under, for a role that may publish it.
      const conflicted = dialog.locator('.pub__row', { hasText: 'Home: the hero' });
      if ((await conflicted.locator('input[type="checkbox"]').count()) > 0) {
        await expect(
          conflicted.getByText('Changed on the live site since this edit started.'),
        ).toBeVisible();
        await expect(publish).toBeDisabled();
        await conflicted.getByRole('button', { name: 'Compare' }).click();
        await expect(conflicted.getByRole('region', { name: 'Live and yours' })).toContainText(
          'Made to be remembered',
        );
        await conflicted.getByRole('button', { name: 'Keep my version' }).click();
        await expect(
          conflicted.getByText('Changed on the live site since this edit started.'),
        ).toHaveCount(0);
      }
      await expect(publish).toBeEnabled();
      await expect(publish).toHaveText(
        `Publish ${counts.publishable} ${counts.publishable === 1 ? 'change' : 'changes'}`,
      );
      await publish.click();
      await expect(
        page.locator('#admin-toasts .toast', {
          hasText: 'Published v15. The website now shows these changes.',
        }),
      ).toBeVisible();
      await expect(dialog).toBeHidden();
      // What is left waits for someone else, or nothing is left.
      if (counts.waiting > 0) {
        await expect(bar.locator('.savebar__lead')).toHaveText(
          savebarLead({ ...counts, publishable: 0, byArea: {} }),
        );
      } else {
        await expect(bar).toHaveCount(0);
      }
    });
  });
}

test.describe('the Publishing card, as admin: dependencies, discard, the keyboard', () => {
  test.use({ storageState: authFile('admin') });

  test('a change a ticked one needs comes along; unticking it takes the dependant out', async ({
    page,
  }) => {
    await open(page, '/admin/kit');
    const bar = page
      .locator('[data-kit="publishing"]')
      .getByRole('region', { name: 'Unpublished changes' });
    await bar.getByRole('button', { name: 'Publish…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Publish to the website' });
    const client = dialog.getByRole('checkbox', { name: 'Sample Client' });
    const project = dialog.getByRole('checkbox', { name: 'Sample Project' });
    await expect(client).toBeChecked();
    await expect(project).toBeChecked();

    // Untick the client: once the check sees the project needs it, the project leaves too.
    await client.uncheck();
    await expect(project).not.toBeChecked();
    await expect(dialog.getByText(/left the selection too/)).toBeVisible();
    await expect(client).not.toBeChecked();

    // Tick the project: the check ticks the client again, and says why.
    await project.check();
    await expect(client).toBeChecked();
    await expect(
      dialog
        .locator('.pub__row', { hasText: 'Sample Client' })
        .getByText(/Included because .*Sample Project.* needs it/),
    ).toBeVisible();
  });

  test('Schedule for: a time too soon is said under it; a good one locks the changes until then', async ({
    page,
  }) => {
    // What the bar says once everything but the hero is scheduled: the model over the same
    // samples, scheduled the same way (the dialog sends the time; the sample seam keeps it).
    const api = sampleReleaseApi('admin');
    const before = await api.pending();
    const rest = before.items
      .filter((item) => item.label?.['en'] !== 'Home: the hero')
      .map((item) => ({ draftId: item.draftId, draftVersion: item.draftVersion }));
    await api.schedule({
      items: rest,
      scheduleAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const after = savebarCounts(buildRows((await api.pending()).items));
    expect(after.publishable).toBe(1);
    // The button counts rows as the bar does (the reordered services are one).
    const chosen = selectedRows(buildRows(before.items), new Set(rest.map((r) => r.draftId)));

    await open(page, '/admin/kit');
    const bar = page
      .locator('[data-kit="publishing"]')
      .getByRole('region', { name: 'Unpublished changes' });
    await bar.getByRole('button', { name: 'Publish…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Publish to the website' });
    await expect(dialog).toBeVisible();
    // The hero is the one the live site moved under: leave it out of this release.
    await dialog.getByRole('checkbox', { name: 'Home: the hero' }).uncheck();

    // Now is the default; Schedule for draws the day and the time, filled in.
    const when = dialog.getByRole('group', { name: 'When' });
    await expect(when.getByRole('radio', { name: 'Now' })).toBeChecked();
    await expect(dialog.getByLabel('Day', { exact: true })).toHaveCount(0);
    await when.getByRole('radio', { name: 'Schedule for' }).check();
    const day = dialog.getByLabel('Day', { exact: true });
    const time = dialog.getByLabel('Time', { exact: true });
    await expect(day).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
    await expect(time).toHaveValue(/^\d{2}:00$/);
    // The time input names the studio's clock it is read on.
    await expect(time).toHaveAccessibleDescription(/ time$/);
    const axe = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(axe.violations, JSON.stringify(axe.violations, null, 2)).toEqual([]);

    const schedule = dialog.getByRole('button', { name: /^Schedule \d+ changes?$/ });
    await expect(schedule).toBeEnabled();
    await expect(schedule).toHaveText(`Schedule ${chosen} changes`);

    // Midnight today, on the studio's clock (the day input's own minimum), has passed.
    const today = await day.getAttribute('min');
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await day.fill(today!);
    await time.fill('00:00');
    await schedule.click();
    await expect(dialog.getByRole('alert')).toHaveText(
      'Choose a time at least 2 minutes from now.',
    );
    await expect(time).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog).toBeVisible();

    // Noon tomorrow is fine.
    const [y, m, d] = today!.split('-').map(Number) as [number, number, number];
    const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    await day.fill(tomorrow);
    await time.fill('12:00');
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await schedule.click();
    await expect(
      page.locator('#admin-toasts .toast', {
        hasText:
          /Scheduled for \d{1,2} \w{3} \d{4}, 12:00 \(.+\)\. These changes are locked until then\./,
      }),
    ).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(bar.locator('.savebar__lead')).toHaveText(savebarLead(after));

    // Open again: what the release holds is listed, locked, and only the hero can be ticked.
    await bar.getByRole('button', { name: 'Publish…' }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Scheduled: locked until it goes live')).toHaveCount(
      after.scheduled,
    );
    await expect(dialog.getByRole('checkbox')).toHaveCount(1);
    await expect(dialog.getByRole('checkbox', { name: 'Home: the hero' })).toBeVisible();
  });

  test('Escape closes the dialog and gives focus back to Publish…', async ({ page }) => {
    await open(page, '/admin/kit');
    const bar = page
      .locator('[data-kit="publishing"]')
      .getByRole('region', { name: 'Unpublished changes' });
    const opener = bar.getByRole('button', { name: 'Publish…' });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Publish to the website' });
    await expect(dialog).toBeVisible();
    // Focus starts on Cancel (nothing is published by a reflexive Enter).
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test('Discard my changes throws the person’s own changes away, after a confirm', async ({
    page,
  }) => {
    const counts = await expected('admin');
    await open(page, '/admin/kit');
    const bar = page
      .locator('[data-kit="publishing"]')
      .getByRole('region', { name: 'Unpublished changes' });
    // Exact: once the menu opens, "Discard my changes (k)" would match a substring too.
    const menu = bar.getByRole('button', { name: 'Discard', exact: true });
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    await bar.getByRole('button', { name: `Discard my changes (${counts.mine})` }).click();
    const confirm = page
      .getByRole('dialog')
      .filter({ hasText: 'Discard your unpublished changes?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Discard' }).click();
    await expect(
      page.locator('#admin-toasts .toast', {
        hasText: `${counts.mine} unpublished changes thrown away.`,
      }),
    ).toBeVisible();
    // Only other people's changes are left: nothing of the admin's own to throw away now.
    await expect(bar.getByRole('button', { name: /^Discard my changes/ })).toHaveCount(0);
  });
});
