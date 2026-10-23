import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { Role } from '@/lib/auth/types';
import {
  buildRows,
  savebarCounts,
  savebarLead,
  type SavebarCounts,
} from '@/components/admin/screens/release/model';
import { sampleReleaseApi } from '@/components/admin/screens/release/sampleApi';
import { SKIP_REASON, STAFF_ROLES, authFile, staffEnv } from './staff';

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

/** A list each role opens, and (for a role that has one) an editor it saves live. */
const SCREENS: Readonly<Record<Role, { list: string; editor: string | null }>> = {
  admin: { list: '/admin/services', editor: '/admin/services' },
  content_creator: { list: '/admin/services', editor: '/admin/services' },
  seo: { list: '/admin/seo', editor: null },
  developer: { list: '/admin/settings', editor: null },
  sales: { list: '/admin/leads', editor: null },
};

for (const role of STAFF_ROLES) {
  test.describe(`releases off, as ${role}`, () => {
    test.use({ storageState: authFile(role) });

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
        await open(page, SCREENS[role].editor!);
        const first = page.locator('a[href^="/admin/services/"]:not([href$="/new"])').first();
        const href = await first.getAttribute('href');
        expect(href).toBeTruthy();
        await open(page, href!);
        // The record's own form (an SEO tab's panel is another form, mounted once opened).
        const form = page.locator('form.editor').first();
        await expect(form).toBeAttached();
        // Every field tab is mounted (U8), so these are in the form whichever tab is shown.
        await expect(form.locator('select#f-status')).toHaveCount(1);
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
