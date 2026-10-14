import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { SKIP_REASON, authFile, staffEnv } from './staff';

// The component kit (Admin v2 F4b, /admin/kit) in a real browser, signed in: the pieces
// that move. The Sortable core by keyboard (lift, move, drop, cancel, each announced), by
// its Move buttons (WCAG 2.5.7: no drag needed) and by pointer, in one list and across
// two; the tabs' keys and their ?tab= address; the data table's selection, bulk bar,
// pages and chips; the modal's and the drawer's focus; the error summary's links; and
// axe with a dialog open and every chart's table showing. The per-role sweep opens the
// same screen for every role (tests/admin/routes.ts, EXTRA_LINKS). The markup and the
// state machine are unit-tested (tests/lib/adminKitReact.spec.ts, sortable.spec.ts,
// tests/astro/).

test.skip(!staffEnv(), SKIP_REASON);
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function open(page: Page, query = '') {
  await page.goto(`/admin/kit${query}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
}

/** The words the Sortable core last said, in whichever list's live region said them. */
function announced(page: Page, text: string) {
  return page.locator('p[aria-live="assertive"]').filter({ hasText: text });
}

test.describe('as admin', () => {
  test.use({ storageState: authFile('admin') });

  test.describe('the Sortable core', () => {
    test.beforeEach(async ({ page }) => {
      await open(page);
      // Mid-screen, so a drag never reaches the band where the page scrolls itself.
      await page
        .getByRole('list', { name: 'Sample sections' })
        .evaluate((el) => el.scrollIntoView({ block: 'center' }));
    });

    const order = (page: Page) =>
      page.getByRole('list', { name: 'Sample sections' }).locator('.li__t').allTextContents();
    const saved = (page: Page) => page.locator('[data-kit-order]');

    test('keyboard: Space lifts, the arrows move, Space drops; each step is said', async ({
      page,
    }) => {
      const handle = page.getByRole('button', { name: 'Reorder Hero' });
      await handle.focus();
      await page.keyboard.press('Space');
      await expect(announced(page, 'Hero lifted, position 1 of 5.')).toHaveCount(1);

      await page.keyboard.press('ArrowDown');
      await expect(announced(page, 'Hero, position 2 of 5.')).toHaveCount(1);
      await page.keyboard.press('ArrowDown');
      await expect(announced(page, 'Hero, position 3 of 5.')).toHaveCount(1);
      // Focus follows the item it moves.
      await expect(handle).toBeFocused();
      expect(await order(page)).toEqual([
        'Services',
        'Selected work',
        'Hero',
        'Clients',
        'Say hello',
      ]);
      // Nothing is saved before the drop.
      await expect(saved(page)).toHaveText(
        'Saved order: Hero, Services, Selected work, Clients, Say hello',
      );

      await page.keyboard.press('Space');
      await expect(announced(page, 'Hero dropped, position 3 of 5.')).toHaveCount(1);
      await expect(saved(page)).toHaveText(
        'Saved order: Services, Selected work, Hero, Clients, Say hello',
      );
      await expect(handle).toBeFocused();
    });

    test('keyboard: Escape puts the item back and says where', async ({ page }) => {
      await page.getByRole('button', { name: 'Reorder Clients' }).focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('ArrowUp');
      expect(await order(page)).toEqual([
        'Hero',
        'Clients',
        'Services',
        'Selected work',
        'Say hello',
      ]);
      await page.keyboard.press('Escape');
      await expect(
        announced(page, 'Reorder cancelled. Clients is back at position 4 of 5.'),
      ).toHaveCount(1);
      expect(await order(page)).toEqual([
        'Hero',
        'Services',
        'Selected work',
        'Clients',
        'Say hello',
      ]);
      await expect(saved(page)).toHaveText(
        'Saved order: Hero, Services, Selected work, Clients, Say hello',
      );
    });

    test('the Move buttons move one place at once, and say so at an edge', async ({ page }) => {
      const up = page.getByRole('button', { name: 'Move Say hello up' });
      await up.click();
      await expect(announced(page, 'Say hello moved to position 4 of 5.')).toHaveCount(1);
      await expect(saved(page)).toHaveText(
        'Saved order: Hero, Services, Selected work, Say hello, Clients',
      );
      await expect(up).toBeFocused();

      const first = page.getByRole('button', { name: 'Move Hero up' });
      await expect(first).toHaveAttribute('aria-disabled', 'true');
      // Still focusable and pressable (aria-disabled, not disabled), so a keyboard or
      // screen reader user hears why nothing moved. Playwright treats aria-disabled as
      // disabled, hence the force.
      await first.click({ force: true });
      await expect(announced(page, 'Hero is already first.')).toHaveCount(1);
      await expect(saved(page)).toHaveText(
        'Saved order: Hero, Services, Selected work, Say hello, Clients',
      );
    });

    test('the Move buttons follow an order their owner changes, not only their own', async ({
      page,
    }) => {
      await page.getByRole('button', { name: 'Move Say hello up' }).click();
      await expect(saved(page)).toHaveText(
        'Saved order: Hero, Services, Selected work, Say hello, Clients',
      );
      await expect(page.getByRole('button', { name: 'Move Clients down' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );

      // The owner puts the first order back (a revert after a failed save, a refresh):
      // React moves the items, not the binder, and the edges must still be right.
      await page.getByRole('button', { name: 'Reset the order' }).click();
      await expect(saved(page)).toHaveText(
        'Saved order: Hero, Services, Selected work, Clients, Say hello',
      );
      expect(await order(page)).toEqual([
        'Hero',
        'Services',
        'Selected work',
        'Clients',
        'Say hello',
      ]);
      await expect(page.getByRole('button', { name: 'Move Say hello down' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      await expect(page.getByRole('button', { name: 'Move Clients down' })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });

    test('a pointer drag from the handle drops where the pointer is let go', async ({ page }) => {
      const handle = page.getByRole('button', { name: 'Reorder Hero' });
      const target = page
        .getByRole('list', { name: 'Sample sections' })
        .getByRole('listitem')
        .filter({ hasText: 'Clients' });
      const from = (await handle.boundingBox())!;
      const to = (await target.boundingBox())!;
      const x = from.x + from.width / 2;
      await page.mouse.move(x, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(x, to.y + to.height * 0.75, { steps: 12 });
      await page.mouse.up();
      await expect(announced(page, 'Hero dropped, position 4 of 5.')).toHaveCount(1);
      await expect(saved(page)).toHaveText(
        'Saved order: Services, Selected work, Clients, Hero, Say hello',
      );
    });

    test('across lists: a Move button and the arrows name the list', async ({ page }) => {
      const right = page.getByRole('list', { name: 'Right column' });
      await page.getByRole('button', { name: 'Move Visits to the next list' }).click();
      await expect(announced(page, 'Visits moved to position 1 of 3 in Right column.')).toHaveCount(
        1,
      );
      await expect(right.locator('.li__t')).toHaveText(['Visits', 'Site health', 'Drafts waiting']);

      await page.getByRole('button', { name: 'Reorder Drafts waiting' }).focus();
      await page.keyboard.press('Space');
      await page.keyboard.press('ArrowLeft');
      await expect(announced(page, 'Drafts waiting, position 2 of 2 in Left column.')).toHaveCount(
        1,
      );
      await page.keyboard.press('Space');
      await expect(page.getByRole('list', { name: 'Left column' }).locator('.li__t')).toHaveText([
        'New inquiries',
        'Drafts waiting',
      ]);
    });
  });

  test('tabs: the arrows move and select, the URL keeps the tab, a reload opens it', async ({
    page,
  }) => {
    await open(page);
    const tablist = page.getByRole('tablist', { name: 'Sample editor' });
    await tablist.getByRole('tab', { name: 'Content' }).focus();
    await page.keyboard.press('ArrowRight');
    const seo = tablist.getByRole('tab', { name: 'SEO' });
    await expect(seo).toBeFocused();
    await expect(seo).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: 'SEO' })).toBeVisible();
    await expect(page).toHaveURL(/[?&]tab=seo(&|$)/);

    await page.keyboard.press('End');
    await expect(tablist.getByRole('tab', { name: 'Media' })).toBeFocused();
    await page.keyboard.press('Home');
    await expect(tablist.getByRole('tab', { name: 'Content' })).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(tablist.getByRole('tab', { name: 'Media' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await page.reload({ waitUntil: 'networkidle' });
    await expect(
      page.getByRole('tablist', { name: 'Sample editor' }).getByRole('tab', { name: 'Media' }),
    ).toHaveAttribute('aria-selected', 'true');
  });

  test('the data table: select, act on the chosen, page, filter', async ({ page }) => {
    await open(page);
    const card = page.getByRole('region', { name: 'A data table' });
    const table = card.getByRole('table', { name: 'Sample entries, with selection' });

    await table.getByRole('checkbox', { name: 'Select Sample entry 1', exact: true }).check();
    await table.getByRole('checkbox', { name: 'Select Sample entry 2', exact: true }).check();
    const bar = page.getByRole('region', { name: 'Bulk actions' });
    await expect(bar).toContainText('2 selected');
    await bar.getByRole('button', { name: 'Mark as reviewed' }).click();
    await expect(card.getByRole('status')).toHaveText('2 sample entries marked as reviewed.');
    await expect(bar).toHaveCount(0);

    const all = table.getByRole('checkbox', { name: 'Select all on this page' });
    await all.check();
    await expect(page.getByRole('region', { name: 'Bulk actions' })).toContainText('25 selected');
    await table.getByRole('checkbox', { name: 'Select Sample entry 3', exact: true }).uncheck();
    expect(await all.evaluate((el) => (el as HTMLInputElement).indeterminate)).toBe(true);
    await page.getByRole('button', { name: 'Clear selection' }).click();

    await card.getByRole('button', { name: 'Page 2', exact: true }).click();
    await expect(card.locator('.tbl__range')).toHaveText('26 to 50 of 60');
    await expect(table.getByRole('link', { name: 'Sample entry 26', exact: true })).toBeVisible();

    await card.getByRole('button', { name: /^Draft/ }).click();
    await expect(card.getByRole('button', { name: /^Draft/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(card.locator('.tbl__range')).toHaveText('1 to 15 of 15');
  });

  test('the data table: a selection is the page’s, so no action reaches a row off screen', async ({
    page,
  }) => {
    await open(page);
    const card = page.getByRole('region', { name: 'A data table' });
    const table = card.getByRole('table', { name: 'Sample entries, with selection' });
    const bar = page.getByRole('region', { name: 'Bulk actions' });
    const first = table.getByRole('checkbox', { name: 'Select Sample entry 1', exact: true });

    // Another page clears the ticks: the bar goes, and coming back finds none.
    await first.check();
    await expect(bar).toContainText('1 selected');
    await card.getByRole('button', { name: 'Page 2', exact: true }).click();
    await expect(card.locator('.tbl__range')).toHaveText('26 to 50 of 60');
    await expect(bar).toHaveCount(0);
    await card.getByRole('button', { name: 'Page 1', exact: true }).click();
    await expect(card.locator('.tbl__range')).toHaveText('1 to 25 of 60');
    await expect(first).not.toBeChecked();

    // A filter that hides a ticked row drops it: Sample entry 1 is published, not a draft.
    await first.check();
    await expect(bar).toContainText('1 selected');
    await card.getByRole('button', { name: /^Draft/ }).click();
    await expect(card.locator('.tbl__range')).toHaveText('1 to 15 of 15');
    await expect(bar).toHaveCount(0);
    await card.getByRole('button', { name: /^All/ }).click();
    await expect(first).not.toBeChecked();
  });

  test('the data table: a hidden row action takes no press; hover arms it, Tab reaches it', async ({
    page,
  }) => {
    await open(page);
    const card = page.getByRole('region', { name: 'A data table' });
    const table = card.getByRole('table', { name: 'Sample entries, with selection' });
    const preview = table.getByRole('button', { name: 'Preview Sample entry 1', exact: true });
    const spot = (await preview.boundingBox())!;
    const x = spot.x + spot.width / 2;
    const y = spot.y + spot.height / 2;

    // From outside the row, a press at once (as a tap is): it goes to the row's link (the
    // sample rows link to #kit-<n>), never to the button nobody could see yet.
    await page.mouse.move(1, 1);
    await page.mouse.click(x, y);
    await expect(page).toHaveURL(/#kit-1$/);
    await expect(card.getByRole('status')).toHaveText('');

    // Resting on the row shows the actions and, once they have faded in, arms them.
    await expect(preview).toHaveCSS('pointer-events', 'auto');
    await page.mouse.click(x, y);
    await expect(card.getByRole('status')).toHaveText(
      'A preview of Sample entry 1 would open here.',
    );

    // The keyboard reaches them from the row's link, and focus shows them.
    await page.mouse.move(1, 1);
    await table.getByRole('link', { name: 'Sample entry 2', exact: true }).focus();
    await page.keyboard.press('Tab');
    const next = table.getByRole('button', { name: 'Preview Sample entry 2', exact: true });
    await expect(next).toBeFocused();
    await expect(next).toHaveCSS('opacity', '1');
  });

  test('the data table: emptying the last page steps back to the page before', async ({ page }) => {
    await open(page);
    const card = page.getByRole('region', { name: 'A data table' });
    const table = card.getByRole('table', { name: 'Sample entries, with selection' });
    await card.getByRole('button', { name: 'Page 3', exact: true }).click();
    await expect(card.locator('.tbl__range')).toHaveText('51 to 60 of 60');

    await table.getByRole('checkbox', { name: 'Select all on this page' }).check();
    await page
      .getByRole('region', { name: 'Bulk actions' })
      .getByRole('button', { name: 'Remove from the sample' })
      .click();
    await expect(card.getByRole('status')).toHaveText('10 entries removed from the sample.');

    // Page 3 no longer exists: the table shows page 2's rows, not an empty page with no
    // pager that reads as if every entry were gone.
    await expect(table.getByRole('link', { name: 'Sample entry 50', exact: true })).toBeVisible();
    await expect(card.locator('.tbl__range')).toHaveText('26 to 50 of 50');
    await expect(card.getByRole('button', { name: 'Page 2', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(card.getByRole('button', { name: 'Page 3', exact: true })).toHaveCount(0);
  });

  test('the modal: focus in its first field, Escape closes, focus goes back', async ({ page }) => {
    await open(page);
    const opener = page.getByRole('button', { name: 'Rename the sample' });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Rename the sample' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('New name')).toBeFocused();

    const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(results.violations, 'axe with the modal open').toEqual([]);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test('the drawer: focus on Close when the body has no field, back to the opener after', async ({
    page,
  }) => {
    await open(page);
    const opener = page.getByRole('button', { name: 'Open the sample drawer' });
    await opener.click();
    const drawer = page.getByRole('dialog', { name: 'Sample details' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Close' })).toBeFocused();

    const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(results.violations, 'axe with the drawer open').toEqual([]);

    await drawer.getByRole('button', { name: 'Done' }).click();
    await expect(drawer).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test('the drawer: only a press on the scrim closes it, never one that starts inside', async ({
    page,
  }) => {
    await open(page);
    await page.getByRole('button', { name: 'Open the sample drawer' }).click();
    const drawer = page.getByRole('dialog', { name: 'Sample details' });
    await expect(drawer).toBeVisible();
    const text = (await drawer
      .getByText('A drawer opens from the inline end', { exact: false })
      .boundingBox())!;
    const panel = (await drawer.boundingBox())!;
    // The scrim: the strip of the viewport left of the drawer (it opens from the right).
    const scrim = { x: panel.x / 2, y: panel.y + panel.height / 2 };
    expect(scrim.x).toBeGreaterThan(20);

    // Selecting the body's text and letting go over the scrim: the browser sends that
    // click to the <dialog> itself, which must not read as a light dismiss.
    await page.mouse.move(text.x + 4, text.y + text.height / 2);
    await page.mouse.down();
    await page.mouse.move(scrim.x, scrim.y, { steps: 6 });
    await page.mouse.up();
    await expect(drawer).toBeVisible();

    await page.mouse.click(scrim.x, scrim.y);
    await expect(drawer).toBeHidden();
  });

  test('a list in a drawer is heard: its live region is inside the dialog', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Arrange the sample shortcuts' }).click();
    const drawer = page.getByRole('dialog', { name: 'Arrange the shortcuts' });
    await expect(drawer).toBeVisible();
    // showModal() makes everything outside the dialog inert, so a region on the body
    // would say each step to no one. The list's region is inside the drawer.
    const live = drawer.locator('p[aria-live="assertive"]');
    await expect(live).toHaveCount(1);

    await drawer.getByRole('button', { name: 'Reorder Pinned pages' }).focus();
    await page.keyboard.press('Space');
    await expect(live).toHaveText('Pinned pages lifted, position 1 of 3.');
    await page.keyboard.press('ArrowDown');
    await expect(live).toHaveText('Pinned pages, position 2 of 3.');
    await page.keyboard.press('Space');
    await expect(live).toHaveText('Pinned pages dropped, position 2 of 3.');
    await expect(
      drawer.getByRole('list', { name: 'Shortcuts on the sample dashboard' }).locator('.li__t'),
    ).toHaveText(['Recent activity', 'Pinned pages', 'Shortcuts']);
    await expect(drawer).toBeVisible();
  });

  test('the error summary takes focus and each link reaches its field', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Check the sample form' }).click();
    const summary = page.getByRole('alert', { name: 'Fix 2 problems to save' });
    await expect(summary).toBeFocused();
    await summary.getByRole('link', { name: 'Give it a name.' }).click();
    await expect(page.getByLabel('Name', { exact: true })).toBeFocused();
  });

  test('server pieces: chart tables, link chips and the paged server table', async ({ page }) => {
    await open(page);
    for (const summary of await page.locator('details.chart-table > summary').all()) {
      await summary.click();
    }
    const lineTable = page.getByRole('table', { name: 'Visits and inquiries per day' });
    await expect(lineTable).toBeVisible();
    await expect(lineTable.getByRole('row')).toHaveCount(15);

    const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(results.violations, 'axe with every chart table open').toEqual([]);

    const chips = page.getByRole('navigation', { name: 'Filter the sample by status' });
    await chips.getByRole('link', { name: /^Draft/ }).click();
    await expect(page).toHaveURL(/[?&]chip=draft(&|$)/);
    await expect(
      page
        .getByRole('navigation', { name: 'Filter the sample by status' })
        .getByRole('link', { name: /^Draft/ }),
    ).toHaveAttribute('aria-current', 'page');

    await open(page, '?page=2');
    const server = page.getByRole('table', { name: 'Sample entries', exact: true });
    await expect(server.getByRole('link', { name: 'Sample entry 26', exact: true })).toBeVisible();
    await expect(page.getByText('26 to 50 of 60', { exact: true }).first()).toBeVisible();
  });
});
