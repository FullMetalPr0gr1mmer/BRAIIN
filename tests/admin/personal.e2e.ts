import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ROLE_LABELS } from '@/lib/authz/capLabels';
import { SKIP_REASON, authFile, staffEnv } from './staff';

// The personal layer (Admin v2 F8) in a real browser, signed in: the bell and the account
// chip open their drawers with JS and are plain links without it; axe finds nothing with
// either drawer open (AV-05); Escape closes a drawer and focus returns to its trigger; a
// rename shows in the sidebar chip at once, from the drawer and from the no-JS page alike;
// a bell row carrying a visitor's long unbroken name wraps instead of widening the drawer.
// The pages themselves are in the per-role sweep (routes.ts EXTRA_LINKS).
//
// Not here, on purpose: Sign out and the password change. Each role's session is shared by
// the whole run (staff.setup.ts), and both would end it (a password change signs out every
// other session). Their rules are unit-tested (tests/lib/accountPassword.spec.ts).

test.skip(!staffEnv(), SKIP_REASON);
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function ready(page: Page, path = '/admin') {
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

for (const role of ['admin', 'seo'] as const) {
  test.describe(`as ${role}`, () => {
    test.use({ storageState: authFile(role) });

    test('the bell opens the notifications drawer; Escape closes it and returns focus', async ({
      page,
    }) => {
      await ready(page);
      const bell = page.locator('.admin-topbar [data-open="notifications"]');
      await expect(bell).toHaveAttribute('aria-label', /^Notifications(, \d+ unread)?$/);
      await bell.click();
      const drawer = page.getByRole('dialog', { name: 'Notifications' });
      await expect(drawer).toBeVisible();
      await expect(page).toHaveURL(/\/admin$/);
      // Loaded on open, then settled: a list or the empty state, never an error.
      await expect(drawer.locator('.ntf, .empty')).toBeVisible();
      await expect(drawer.getByRole('status')).not.toHaveText(/could not/);
      await expectNoAxeViolations(page, `${role}: the notifications drawer`);

      await page.keyboard.press('Escape');
      await expect(drawer).toBeHidden();
      await expect(bell).toBeFocused();
    });

    test('the account chip opens the account drawer with the role and what it can do', async ({
      page,
    }) => {
      await ready(page);
      const chip = page.locator('.side__user[data-open="account"]');
      await chip.click();
      const drawer = page.getByRole('dialog', { name: 'Your account' });
      await expect(drawer).toBeVisible();
      await expect(drawer.locator('.acct__who .badge')).toHaveText(ROLE_LABELS[role]);
      await expect(drawer.locator('.acct__can li').first()).toBeVisible();
      // E-mail changes need delivery, which is not set up: said, not hidden. Exact: the
      // row's own line also says "not set up yet", and a substring match finds both.
      await expect(drawer.getByText('Not set up', { exact: true })).toBeVisible();
      await expectNoAxeViolations(page, `${role}: the account drawer`);

      await drawer.getByRole('button', { name: 'Close' }).click();
      await expect(drawer).toBeHidden();
      await expect(chip).toBeFocused();
    });
  });
}

test.describe('what visitors typed', () => {
  test.use({ storageState: authFile('admin') });

  test('a long unbroken name in a bell row wraps: the drawer never scrolls sideways', async ({
    page,
  }) => {
    // A lead's name and an applicant's role come from public forms, up to 120 characters,
    // and nothing stops one from being a single word. The list is the server's answer,
    // replaced here so the row does not depend on what the local database holds.
    const word = 'W'.repeat(120);
    const at = new Date().toISOString();
    await page.route('**/api/admin/notifications', (route) =>
      route.fulfill({
        json: {
          ok: true,
          data: {
            items: [
              {
                id: 'leads:e2e-long-name',
                kind: 'leads',
                icon: 'inbox',
                text: `New inquiry from ${word}`,
                detail: word,
                at,
                href: null,
                unread: true,
              },
            ],
            unread: 1,
            seenAt: null,
            failed: [],
            asOf: at,
          },
        },
      }),
    );
    await ready(page);
    await page.locator('.admin-topbar [data-open="notifications"]').click();
    const drawer = page.getByRole('dialog', { name: 'Notifications' });
    await expect(drawer.locator('.li__t')).toContainText(word);
    const sideways = await drawer
      .locator('.drw__b')
      .evaluate((body) => body.scrollWidth - body.clientWidth);
    expect(sideways).toBeLessThanOrEqual(1);
  });
});

test.describe('mark all as read', () => {
  test.use({ storageState: authFile('seo') });

  test('marks up to when the list was read, not the moment of the click', async ({ page }) => {
    // The list says when the server read it; the drawer must send that back, so whatever
    // arrived while the drawer was open stays new. Both answers are the server's shapes.
    const asOf = '2026-10-10T11:58:30.000Z';
    await page.route('**/api/admin/notifications', (route) =>
      route.fulfill({
        json: {
          ok: true,
          data: {
            items: [
              {
                id: 'maintenance:e2e',
                kind: 'maintenance',
                icon: 'warn',
                text: 'Maintenance mode was turned on',
                detail: 'Visitors see the maintenance page.',
                at: asOf,
                href: null,
                unread: true,
              },
            ],
            unread: 1,
            seenAt: null,
            failed: [],
            asOf,
          },
        },
      }),
    );
    const sent: unknown[] = [];
    await page.route('**/api/admin/notifications/seen', (route) => {
      sent.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true, data: { seenAt: asOf } } });
    });
    await ready(page);
    await page.locator('.admin-topbar [data-open="notifications"]').click();
    const drawer = page.getByRole('dialog', { name: 'Notifications' });
    await expect(drawer.locator('.li[data-unread]')).toHaveCount(1);
    await drawer.getByRole('button', { name: 'Mark all as read' }).click();
    await expect(drawer.getByRole('status')).toHaveText('All caught up.');
    expect(sent).toEqual([{ asOf }]);
    await expect(drawer.locator('.li[data-unread]')).toHaveCount(0);
  });
});

test.describe('renaming yourself', () => {
  test.use({ storageState: authFile('developer') });

  test('from the drawer: saved, and the sidebar chip follows without a reload', async ({
    page,
  }) => {
    await ready(page);
    const chipName = page.locator('.side__user [data-account-name]');
    const original = (await chipName.textContent())?.trim() ?? '';
    try {
      await page.locator('.side__user[data-open="account"]').click();
      const drawer = page.getByRole('dialog', { name: 'Your account' });
      await drawer.getByLabel('Display name').fill('Renamed In Drawer');
      await drawer.getByRole('button', { name: 'Save name' }).click();
      await expect(drawer.getByText('Your name is saved.')).toBeVisible();
      await expect(chipName).toHaveText('Renamed In Drawer');
      await expect(page.locator('.side__user [data-account-initials]')).toHaveText('RD');

      await ready(page);
      await expect(chipName).toHaveText('Renamed In Drawer');
    } finally {
      const res = await page.request.patch('/api/admin/me', {
        data: { display_name: original },
        headers: { 'x-csrf-token': await csrf(page) },
      });
      expect(res.status()).toBe(200);
    }
  });
});

test.describe('on a phone', () => {
  test.use({ storageState: authFile('seo'), viewport: { width: 390, height: 844 } });

  test('the account drawer opens from the sidebar popover, and closing it strands no focus', async ({
    page,
  }) => {
    await ready(page);
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.locator('.side__user[data-open="account"]').click();
    const drawer = page.getByRole('dialog', { name: 'Your account' });
    await expect(drawer).toBeVisible();
    // Full width under 600px: nothing scrolls sideways with it open.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(2);

    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    // Back on the chip if the sidebar is still open, else on the Menu button: never <body>.
    expect(await page.evaluate(() => document.activeElement?.tagName ?? 'BODY')).not.toBe('BODY');
  });
});

test.describe('without JavaScript', () => {
  test.use({ storageState: authFile('content_creator'), javaScriptEnabled: false });

  test('the bell and the account chip are links to their pages', async ({ page }) => {
    await page.goto('/admin');
    await page.locator('.admin-topbar [data-open="notifications"]').click();
    await expect(page).toHaveURL(/\/admin\/notifications$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();

    await page.locator('.side__user[data-open="account"]').click();
    await expect(page).toHaveURL(/\/admin\/account$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();
  });

  test('the account page renames without any script, and says so', async ({ page }) => {
    // The page's own form, in main: the drawer's copy is server-rendered too, in a closed
    // dialog outside it.
    const main = page.locator('main#content');
    await page.goto('/admin/account');
    const original = (await main.getByLabel('Display name').inputValue()).trim();
    try {
      await main.getByLabel('Display name').fill('Renamed Without Script');
      await main.getByRole('button', { name: 'Save name' }).click();
      await expect(page).toHaveURL(/\/admin\/account\?saved=name$/);
      await expect(main.getByText('Your name is saved.')).toBeVisible();
      await expect(page.locator('.side__user [data-account-name]')).toHaveText(
        'Renamed Without Script',
      );
    } finally {
      await page.goto('/admin/account');
      await main.getByLabel('Display name').fill(original);
      await main.getByRole('button', { name: 'Save name' }).click();
      await expect(page).toHaveURL(/\/admin\/account\?saved=name$/);
    }
  });
});

/** The double-submit token the admin's own fetches send (the `__Host-csrf` cookie). */
async function csrf(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  return cookies.find((c) => c.name === '__Host-csrf')?.value ?? '';
}
