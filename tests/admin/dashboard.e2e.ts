import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { Role } from '@/lib/auth/types';
import { widgetsFor } from '@/lib/admin/dashboard/widgets';
import { SKIP_REASON, authFile, staffEnv } from './staff';

// The dashboard (Admin v2 U1) in a real browser, signed in. Per role: the board shows only the
// role's widgets (Content Creator and SEO no lead or application widget), with axe clean and
// nothing scrolling sideways at 320, 390 and 1280px. As Admin: Customize by keyboard (the Move
// buttons, the Sortable keys, Hide, Add widget, a reload keeping the order, Reset through its
// confirm); the quick-actions drawer (a library action added and reordered by keyboard, an
// https link of one's own that opens with rel="noopener noreferrer", a javascript: link
// refused inline); the team notes (saved, a 409 from a second tab, a phone number refused with
// the rule's words); a preset saved for SEO that a fresh SEO session sees. Axe runs with each
// drawer and modal open. Every preference and preset a test changes is put back.

test.skip(!staffEnv(), SKIP_REASON);
test.use({ contextOptions: { reducedMotion: 'reduce' } });
// The tests share the accounts' preferences and the tenant's note: one at a time.
test.describe.configure({ mode: 'serial' });

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function open(page: Page, path = '/admin') {
  const res = await page.goto(path, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  return res;
}

async function axe(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect
    .soft(
      violations.map((v) => `${v.id} [${v.impact ?? 'n/a'}] ${v.nodes.length}x: ${v.help}`),
      `axe on ${label}`,
    )
    .toEqual([]);
}

/** An admin API call from the page, with its CSRF token, as the island makes them. */
async function api<T>(page: Page, method: string, url: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ({ method, url, body }) => {
      const token =
        document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ?? '';
      const res = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
          ...(method === 'GET' ? {} : { 'x-csrf-token': token }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const json = (await res.json()) as { data?: unknown };
      return json.data as T;
    },
    { method, url, body },
  );
}

/** Puts the signed-in person's dashboard back to their role's: no columns, no quick list. */
async function resetMine(page: Page) {
  const prefs = await api<{ version: number }>(page, 'GET', '/api/admin/me/preferences');
  await api(page, 'PUT', '/api/admin/me/preferences', {
    version: prefs.version,
    dashboard: {},
    quickActions: [],
  });
}

/** The widget ids of one column, in order. */
const column = (page: Page, key: 'top' | 'left' | 'right') =>
  page
    .locator(`[data-sortable-list="${key}"] > [data-widget]`)
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-widget')));

const board = (page: Page) =>
  page
    .locator('[data-dash] [data-widget]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-widget')));

/** Waits for the island's next preferences save to land. */
const saved = (page: Page) =>
  page.waitForResponse(
    (r) => r.url().endsWith('/api/admin/me/preferences') && r.request().method() === 'PUT',
  );

for (const role of ['admin', 'content_creator', 'seo', 'developer'] as Role[]) {
  test.describe(`as ${role}`, () => {
    test.use({ storageState: authFile(role) });

    test('the board shows only the role’s widgets, at 320, 390 and 1280px', async ({ page }) => {
      await open(page);
      await resetMine(page);
      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        const res = await open(page);
        expect(res?.status()).toBe(200);
        const shown = await board(page);
        expect(shown.length).toBeGreaterThan(0);
        for (const id of shown) expect(widgetsFor(role) as string[], `${role} ${id}`).toContain(id);
        if (role === 'content_creator' || role === 'seo') {
          for (const id of ['leads', 'disciplines', 'applications'])
            expect(shown).not.toContain(id);
          await expect(page.getByText('New leads waiting')).toHaveCount(0);
        }
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(
          /^Good (morning|afternoon|evening), /,
        );
        await expect.soft(page.locator('main .msg[data-kind="error"]')).toHaveCount(0);
        await axe(page, `${role} /admin at ${width}px`);
        const overflow = await page.evaluate(() => {
          const root = document.scrollingElement ?? document.documentElement;
          return root.scrollWidth - root.clientWidth;
        });
        expect.soft(overflow, `${role} overflow at ${width}px`).toBeLessThanOrEqual(2);
      }
    });
  });
}

test.describe('as admin, arranging the dashboard', () => {
  test.use({ storageState: authFile('admin') });

  test.beforeEach(async ({ page }) => {
    await open(page);
    await resetMine(page);
    await open(page);
  });
  test.afterEach(async ({ page }) => {
    await resetMine(page);
  });

  test('Customize by keyboard: move, move across, the Sortable keys, hide, add, reset', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Customize', exact: true }).click();
    const bar = page.getByRole('region', { name: 'Customize the dashboard' });
    await expect(bar).toBeVisible();
    await axe(page, 'Customize on');
    expect(await column(page, 'left')).toEqual(['quick', 'views', 'leads']);

    // A Move button, one click.
    let landed = saved(page);
    await page.getByRole('button', { name: 'Move Quick actions down' }).click();
    await landed;
    expect(await column(page, 'left')).toEqual(['views', 'quick', 'leads']);

    // Across the columns: its label follows where it is.
    landed = saved(page);
    await page.getByRole('button', { name: 'Move Quick actions to the right column' }).click();
    await landed;
    expect((await column(page, 'right'))[1]).toBe('quick');
    await expect(
      page.getByRole('button', { name: 'Move Quick actions to the left column' }),
    ).toBeVisible();

    // The Sortable keys on a handle: lift, move down, drop.
    const handle = page.getByRole('button', { name: 'Reorder Page views, last 30 days' });
    await handle.focus();
    landed = saved(page);
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');
    await landed;
    expect(await column(page, 'left')).toEqual(['leads', 'views']);

    // Hide, then bring it back from the drawer (it saves and reloads).
    landed = saved(page);
    await page.getByRole('button', { name: 'Hide Recent activity' }).click();
    await landed;
    expect(await board(page)).not.toContain('activity');
    await page.getByRole('button', { name: 'Add widget' }).click();
    const drawer = page.getByRole('dialog', { name: 'Add a widget' });
    await expect(drawer).toBeVisible();
    await axe(page, 'the Add widget drawer');
    const reload = page.waitForEvent('load');
    await drawer
      .getByRole('button', { name: 'Left: add Recent activity to the left column' })
      .click();
    await reload;
    await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
    expect(await column(page, 'left')).toEqual(['leads', 'views', 'activity']);

    // A reload keeps the order.
    await open(page);
    expect(await column(page, 'left')).toEqual(['leads', 'views', 'activity']);

    // Reset asks first, then puts the role's layout back.
    await page.getByRole('button', { name: 'Customize', exact: true }).click();
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'Reset the dashboard?' });
    await expect(confirm).toBeVisible();
    await axe(page, 'the Reset confirm');
    const back = page.waitForEvent('load');
    await confirm.getByRole('button', { name: 'Reset', exact: true }).click();
    await back;
    expect(await column(page, 'left')).toEqual(['quick', 'views', 'leads']);
  });

  test('quick actions: add from the library, reorder by keyboard, an https link of one’s own', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Customize quick actions' }).click();
    const drawer = page.getByRole('dialog', { name: 'Customize quick actions' });
    await expect(drawer).toBeVisible();
    await axe(page, 'the quick-actions drawer');

    await drawer.getByRole('button', { name: 'Edit SEO: add to your quick actions' }).click();
    const list = drawer.getByRole('list', { name: 'Your quick actions' });
    await expect(list.getByText('Edit SEO')).toBeVisible();
    const before = await list
      .locator('[data-sortable-id]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-sortable-id')));
    await drawer.getByRole('button', { name: 'Reorder Edit SEO' }).focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Space');
    const after = await list
      .locator('[data-sortable-id]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-sortable-id')));
    expect(after.indexOf('edit-seo')).toBe(before.indexOf('edit-seo') - 1);

    // A javascript: link is refused where it is typed.
    await drawer.getByLabel('Label').fill('Bad');
    await drawer.getByLabel('Link').fill('javascript:alert(1)');
    await drawer.getByRole('button', { name: 'Add action' }).click();
    await expect(
      drawer.getByText('Use an admin path starting with /admin, or an https:// address.'),
    ).toBeVisible();

    await drawer.getByLabel('Label').fill('Drive');
    await drawer.getByLabel('Link').fill('https://drive.example.com/team');
    await drawer.getByRole('button', { name: 'Add action' }).click();
    await expect(list.getByText('Drive', { exact: true })).toBeVisible();

    const reload = page.waitForEvent('load');
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    await reload;
    const link = page.locator('[data-widget="quick"] a', { hasText: 'Drive' });
    await expect(link).toHaveAttribute('href', 'https://drive.example.com/team');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(page.locator('[data-widget="quick"]').getByText('Edit SEO')).toBeVisible();
  });

  test('team notes: saved, a conflict from a second tab, a phone number refused', async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    // The notes widget is off the board by default: add it.
    await page.getByRole('button', { name: 'Customize', exact: true }).click();
    await page.getByRole('button', { name: 'Add widget' }).click();
    const reload = page.waitForEvent('load');
    await page
      .getByRole('dialog', { name: 'Add a widget' })
      .getByRole('button', { name: 'Right: add Team notes to the right column' })
      .click();
    await reload;
    await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);

    const notes = page.locator('[data-widget="notes"]');
    await notes.getByRole('button', { name: 'Edit notes' }).click();
    const box = notes.getByRole('textbox', { name: /Team notes/ });
    await expect(box).toBeVisible();
    await axe(page, 'the notes editor');

    await box.fill('Shoot moved to the 14th.');
    await notes.getByRole('button', { name: 'Save team notes' }).click();
    await expect(notes.getByText(/^Version \d+$/)).toBeVisible();

    // A phone number is refused with the rule's words, and nothing is saved.
    await box.fill('Call the client on 0551234567');
    await notes.getByRole('button', { name: 'Save team notes' }).click();
    await expect(
      notes.getByText(/Remove e-mail addresses and phone numbers/).first(),
    ).toBeVisible();

    // A second tab saves first: this one is told, and keeps its words.
    const other = await context.newPage();
    await open(other);
    const otherNotes = other.locator('[data-widget="notes"]');
    await otherNotes.getByRole('button', { name: 'Edit notes' }).click();
    const otherBox = otherNotes.getByRole('textbox', { name: /Team notes/ });
    await otherBox.fill('From the other tab.');
    await otherNotes.getByRole('button', { name: 'Save team notes' }).click();
    await expect(otherNotes.getByText(/^Version \d+$/)).toBeVisible();
    await other.close();

    await box.fill('My late change.');
    await notes.getByRole('button', { name: 'Save team notes' }).click();
    await expect(
      notes.getByText('Someone else saved changes while you were editing.'),
    ).toBeVisible();
    await expect(box).toHaveValue('My late change.');
    await expect(notes.getByRole('button', { name: 'Reload their version' })).toBeVisible();
  });

  test('a preset saved for SEO is what a fresh SEO session sees', async ({ page, browser }) => {
    // A layout of its own SEO can recognise: the KPI row hidden.
    await page.getByRole('button', { name: 'Customize', exact: true }).click();
    const landed = saved(page);
    await page.getByRole('button', { name: 'Hide Key numbers' }).click();
    await landed;
    await page.getByRole('button', { name: 'Save as the default for a role' }).click();
    const modal = page.getByRole('dialog', { name: 'Save as the default for a role' });
    await expect(modal).toBeVisible();
    await modal.getByLabel('Role').selectOption('seo');
    await expect(
      modal.getByText(/SEO (has a saved default|uses the standard layout)\./),
    ).toBeVisible();
    await axe(page, 'the presets modal');
    await modal.getByRole('button', { name: 'Save for SEO' }).click();
    await expect(modal.getByRole('status')).toContainText('Saved.');

    const seo = await browser.newContext({ storageState: authFile('seo') });
    const seoPage = await seo.newPage();
    try {
      await open(seoPage);
      await resetMine(seoPage);
      await open(seoPage);
      expect(await board(seoPage)).not.toContain('kpis');
      expect((await board(seoPage)).length).toBeGreaterThan(0);
    } finally {
      await seo.close();
      // Back to the standard layout for SEO.
      await modal.getByRole('button', { name: 'Reset that role to the standard layout' }).click();
      await expect(modal.getByRole('status')).toContainText('back to the standard layout');
    }
  });
});
