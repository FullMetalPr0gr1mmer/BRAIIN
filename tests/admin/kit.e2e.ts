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

async function open(page: Page, query = '', path = '/admin/kit') {
  await page.goto(`${path}${query}`, { waitUntil: 'networkidle' });
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
    // The table sits far below the first screen: bring the row into view, then measure,
    // so the presses below land on it and not outside the viewport.
    await preview.scrollIntoViewIfNeeded();
    await page.mouse.move(1, 1);
    const spot = (await preview.boundingBox())!;
    const x = spot.x + spot.width / 2;
    const y = spot.y + spot.height / 2;
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(page.viewportSize()!.height);

    // From outside the row, a press at once (as a tap is): it goes to the row's link (the
    // sample rows link to #kit-<n>), never to the button nobody could see yet.
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

  test('a list row: a hidden action takes no press; hover arms it, Tab reaches it', async ({
    page,
  }) => {
    await open(page);
    // A ListRow whose title links to #kit-work, with one action, "Edit", linking to
    // #kit-work-edit (a zero-JS page: where the press went is the address it led to).
    const title = page.getByRole('link', { name: 'Selected work', exact: true });
    const edit = page.getByRole('link', { name: 'Edit Selected work', exact: true });
    await edit.scrollIntoViewIfNeeded();
    await page.mouse.move(1, 1);
    const spot = (await edit.boundingBox())!;
    const x = spot.x + spot.width / 2;
    const y = spot.y + spot.height / 2;
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(page.viewportSize()!.height);

    // From outside the row, a press at once: the row's title link takes it.
    await page.mouse.click(x, y);
    await expect(page).toHaveURL(/#kit-work$/);

    // Resting on the row shows the action and, once it has faded in, arms it.
    await expect(edit).toHaveCSS('pointer-events', 'auto');
    await page.mouse.click(x, y);
    await expect(page).toHaveURL(/#kit-work-edit$/);

    // The keyboard reaches it from the title link, and focus shows it.
    await page.mouse.move(1, 1);
    await title.focus();
    await page.keyboard.press('Tab');
    await expect(edit).toBeFocused();
    await expect(edit.locator('..')).toHaveCSS('opacity', '1');
  });

  test('the data table: emptying the last page steps back to the page before', async ({ page }) => {
    await open(page);
    const card = page.getByRole('region', { name: 'A data table' });
    const table = card.getByRole('table', { name: 'Sample entries, with selection' });
    await card.getByRole('button', { name: 'Page 3', exact: true }).click();
    // The sample answers a moment later, as a list API does: wait for page 3's rows.
    await expect(table.getByRole('link', { name: 'Sample entry 51', exact: true })).toBeVisible();
    await expect(card.locator('.tbl__range')).toHaveText('51 to 60 of 60');

    // Every node the table adds from here on. Between the step back and page 2's rows the
    // table must say it is loading, never draw its empty state ("Nothing here yet") over
    // a range of rows that are not there.
    await card.evaluate((el) => {
      const seen: string[] = [];
      (window as unknown as { kitAdded: string[] }).kitAdded = seen;
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node.textContent?.includes('Nothing here yet')) seen.push(node.textContent);
          }
        }
      }).observe(el, { childList: true, subtree: true });
    });

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
    expect(
      await page.evaluate(() => (window as unknown as { kitAdded: string[] }).kitAdded),
    ).toEqual([]);
  });

  test.describe('at phone width nothing scrolls sideways (WCAG 1.4.10)', () => {
    // The per-role sweep runs at 1280. A table wider than a phone scrolls inside its
    // .table-wrap; nothing in it may widen the page (the "Actions" heading's visually
    // hidden text once did, from every list screen). /admin/service-cases is a ResourceTable
    // list (the Services overview became a list of disciplines in Admin v2 U5), measured once
    // its rows are in.
    for (const width of [320, 390]) {
      for (const path of ['/admin/service-cases', '/admin/kit']) {
        test(`${path} at ${width}px`, async ({ page }) => {
          await page.setViewportSize({ width, height: 800 });
          await open(page, '', path);
          await expect(page.locator('table.data a.data-link').first()).toBeVisible();
          const overflow = await page.evaluate(() => {
            const root = document.scrollingElement ?? document.documentElement;
            return root.scrollWidth - root.clientWidth;
          });
          expect(overflow).toBeLessThanOrEqual(2);
        });
      }
    }
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
    // The lift also says how to go on (the core's HOW_TO sentence).
    await expect(live).toHaveText(
      'Pinned pages lifted, position 1 of 3. Use the arrow keys to move it, Space to drop it, or Escape to cancel.',
    );
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

    // A page past the end shows the last page's rows, not an empty table under its range.
    await open(page, '?page=99');
    await expect(
      page
        .getByRole('table', { name: 'Sample entries', exact: true })
        .getByRole('link', { name: 'Sample entry 51', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('51 to 60 of 60', { exact: true }).first()).toBeVisible();
  });
});

// ---- The field kit v2 (Admin v2 F5a): the "Fields" card on /admin/kit -----------------
// Every field kind on made-up values (screens/kit/samples.ts KIT_FIELDS), in the editor's
// language context. The markup and the rules are unit-tested (tests/lib/adminFields.spec.ts,
// editorForm.spec.ts, fieldErrors.spec.ts); here a browser drives what moves.

test.describe('the field kit, as admin', () => {
  test.use({ storageState: authFile('admin') });

  const fields = (page: Page) => page.getByRole('region', { name: 'Fields', exact: true });
  const steps = (page: Page) => fields(page).getByRole('list', { name: 'Step' });
  const stepTitles = (page: Page) => steps(page).locator('.repeat__t').allTextContents();

  test.beforeEach(async ({ page }) => {
    await open(page);
    await fields(page).evaluate((el) => el.scrollIntoView({ block: 'start' }));
  });

  test('the repeater reorders by keyboard, each step said, and by its Move buttons', async ({
    page,
  }) => {
    const handle = fields(page).getByRole('button', { name: 'Reorder Brief' });
    await handle.focus();
    await page.keyboard.press('Space');
    await expect(announced(page, 'Brief lifted, position 1 of 3.')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await expect(announced(page, 'Brief, position 2 of 3.')).toHaveCount(1);
    await page.keyboard.press('Space');
    await expect(announced(page, 'Brief dropped, position 2 of 3.')).toHaveCount(1);
    await expect(handle).toBeFocused();
    expect(await stepTitles(page)).toEqual(['Sketch', 'Brief', 'Deliver']);
    // The item's number follows its place; its fields' ids follow it too.
    await expect(steps(page).locator('.repeat__n').first()).toHaveText('Step 1');
    await expect(fields(page).locator('#f-steps-0-title-en')).toHaveValue('Sketch');

    await fields(page).getByRole('button', { name: 'Move Deliver up' }).click();
    await expect(announced(page, 'Deliver moved to position 2 of 3.')).toHaveCount(1);
    expect(await stepTitles(page)).toEqual(['Sketch', 'Deliver', 'Brief']);
    await expect(fields(page).getByRole('button', { name: 'Move Sketch up' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  test('the repeater adds up to its most, collapses an item and removes one', async ({ page }) => {
    const add = fields(page).getByRole('button', { name: 'Add step' });
    await add.click();
    await expect(steps(page).getByRole('listitem')).toHaveCount(4);
    await expect(fields(page).getByRole('button', { name: 'At most 4' })).toBeDisabled();

    const collapse = fields(page).getByRole('button', { name: 'Collapse Sketch' });
    await collapse.click();
    await expect(fields(page).locator('#f-steps-1-title-en')).toBeHidden();
    await expect(fields(page).getByRole('button', { name: 'Expand Sketch' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    await fields(page).getByRole('button', { name: 'Remove step 4' }).click();
    await expect(steps(page).getByRole('listitem')).toHaveCount(3);
    await expect(fields(page).getByRole('button', { name: 'Add step' })).toBeEnabled();
  });

  test('a switch toggles with Space and says its state', async ({ page }) => {
    const toggle = fields(page).getByRole('switch', { name: 'Show the sample on the site' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    // A click on its label toggles it too (a label for a button forwards the click).
    await fields(page).getByText('Show the sample on the site', { exact: true }).click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  test('English, Arabic, Both: the halves follow the editor’s language', async ({ page }) => {
    const en = fields(page).locator('#f-title-en');
    const ar = fields(page).locator('#f-title-ar');
    await expect(en).toBeVisible();
    await expect(ar).toBeHidden();
    // The missing Arabic is named on the field's own switch, and counted.
    await expect(
      fields(page)
        .getByRole('group', { name: 'Sample name language' })
        .getByRole('radio', { name: 'Arabic (missing)' }),
    ).toHaveCount(1);
    await expect(fields(page).getByText('Arabic missing: 1')).toBeVisible();

    const language = fields(page).getByRole('group', { name: 'Editing language' });
    await language.getByRole('radio', { name: 'Both' }).check();
    await expect(en).toBeVisible();
    await expect(ar).toBeVisible();
    await expect(ar).toHaveAttribute('dir', 'rtl');

    await language.getByRole('radio', { name: 'العربية' }).check();
    await expect(en).toBeHidden();
    await expect(ar).toBeVisible();

    // The field's own switch overrides the editor's language for that field only.
    await fields(page)
      .getByRole('group', { name: 'Sample name language' })
      .getByRole('radio', { name: 'English' })
      .check();
    await expect(en).toBeVisible();
    await expect(fields(page).locator('#f-blurb-ar')).toBeVisible();

    // Writing the Arabic closes the gap.
    await fields(page)
      .getByRole('group', { name: 'Sample name language' })
      .getByRole('radio', { name: 'Arabic (missing)' })
      .check();
    await ar.fill('عينة');
    await expect(fields(page).getByText('Arabic missing: 1')).toHaveCount(0);
    await expect(
      fields(page)
        .getByRole('group', { name: 'Sample name language' })
        .getByRole('radio', { name: 'Arabic', exact: true }),
    ).toHaveCount(1);
  });

  test('an error in the hidden Arabic half: the summary link shows it and focuses it', async ({
    page,
  }) => {
    const ar = fields(page).locator('#f-title-ar');
    await expect(ar).toBeHidden();
    await fields(page).getByRole('button', { name: 'Check the sample fields' }).click();
    const summary = fields(page).getByRole('alert', { name: 'Fix 4 problems to save' });
    await expect(summary).toBeFocused();
    await expect(ar).toHaveAttribute('aria-invalid', 'true');
    await summary
      .getByRole('link', { name: 'Sample name (Arabic): Write the name in Arabic too.' })
      .click();
    await expect(ar).toBeVisible();
    await expect(ar).toBeFocused();
    // The inline message is the input's description.
    await expect(ar).toHaveAccessibleDescription(/Write the name in Arabic too\./);
  });

  test('"Next gap" shows and focuses each missing Arabic in turn', async ({ page }) => {
    await fields(page).getByRole('button', { name: 'Next gap' }).click();
    const ar = fields(page).locator('#f-title-ar');
    await expect(ar).toBeVisible();
    await expect(ar).toBeFocused();
  });

  test('chips: Enter and a comma add, the remove button names its chip, Arabic chips are RTL', async ({
    page,
  }) => {
    const box = fields(page).locator('#f-tags');
    await box.fill('poster');
    await box.press('Enter');
    await box.pressSequentially('motion,');
    await expect(fields(page).getByRole('button', { name: 'Remove tag poster' })).toHaveCount(1);
    await expect(fields(page).getByRole('button', { name: 'Remove tag motion' })).toHaveCount(1);
    await fields(page).getByRole('button', { name: 'Remove tag kit' }).click();
    await expect(fields(page).getByRole('button', { name: 'Remove tag kit' })).toHaveCount(0);
    await expect(fields(page).getByText('3 of 5', { exact: true })).toBeVisible();
    // The bilingual set's Arabic list is typed right to left, its chips marked Arabic.
    await fields(page)
      .getByRole('group', { name: 'Keywords language' })
      .getByRole('radio', { name: 'Arabic' })
      .check();
    await expect(fields(page).locator('#f-keywords-ar')).toHaveAttribute('dir', 'rtl');
    await expect(fields(page).getByRole('button', { name: 'Remove tag هوية' })).toBeVisible();
  });

  test('colour: a swatch is pressed by value, the hex follows, the contrast is in words', async ({
    page,
  }) => {
    const hex = fields(page).locator('#f-tint');
    await expect(hex).toHaveValue('#0024BC');
    await expect(fields(page).getByRole('button', { name: '#0024BC' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await fields(page).getByRole('button', { name: '#0B0D14' }).click();
    await expect(hex).toHaveValue('#0B0D14');
    await expect(fields(page).getByRole('button', { name: '#0B0D14' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(fields(page).getByText(/White text on it: \d+\.\d:1, passes AA\./)).toBeVisible();
  });

  test('the rich-text link dialog refuses an address the page would drop, and adds a site link', async ({
    page,
  }) => {
    const editor = fields(page).getByRole('textbox', { name: 'Sample body English' });
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.press('End');
    await fields(page)
      .getByRole('toolbar', { name: 'Sample body English formatting' })
      .getByRole('button', { name: 'Link' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Add a link' });
    await expect(dialog).toBeVisible();
    const address = dialog.getByLabel('Link address');
    await expect(address).toBeFocused();
    await address.fill('javascript:alert(1)');
    await dialog.getByRole('button', { name: 'Add link' }).click();
    await expect(dialog.getByText(/Use a web address/)).toBeVisible();
    await address.fill('/about');
    await dialog.getByRole('button', { name: 'Add link' }).click();
    await expect(dialog).toBeHidden();
    await expect(editor.locator('a[href="/about"]')).toHaveCount(1);
  });

  test('axe: every field open, in Both, with the errors shown and the link dialog open', async ({
    page,
  }) => {
    await fields(page)
      .getByRole('group', { name: 'Editing language' })
      .getByRole('radio', { name: 'Both' })
      .check();
    await expect(fields(page).getByRole('textbox', { name: 'Sample body Arabic' })).toBeVisible();
    await fields(page).getByRole('button', { name: 'Check the sample fields' }).click();
    const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(results.violations, 'axe with every field open').toEqual([]);

    await fields(page)
      .getByRole('toolbar', { name: 'Sample body English formatting' })
      .getByRole('button', { name: 'Link' })
      .click();
    await expect(page.getByRole('dialog', { name: 'Add a link' })).toBeVisible();
    const withDialog = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(withDialog.violations, 'axe with the link dialog open').toEqual([]);
  });
});

// ---- The rest of the field kit (Admin v2 F5b) on /admin/kit ---------------------------
// The accent, link, slug-list and clip fields on made-up values. The screen still reads
// nothing until something is reached: only the link picker asks for anything, and only
// once it is focused (this suite runs as admin, which may read the list).

test.describe('the rest of the field kit, as admin', () => {
  test.use({ storageState: authFile('admin') });
  test.beforeEach(async ({ page }) => {
    await open(page);
  });
  const fields = (page: Page) => page.getByRole('region', { name: 'Fields', exact: true });

  test('accent: the words are the heading’s, and the preview follows the pick', async ({
    page,
  }) => {
    const from = fields(page).locator('#f-accent-en-from');
    const to = fields(page).locator('#f-accent-en-to');
    // The sample name is "Sample entry": word 2 is highlighted.
    await expect(from).toHaveValue('1');
    await expect(fields(page).locator('.accentf__on')).toHaveText('entry');

    // Moving the start keeps an end that is still after it.
    await from.selectOption('0');
    await expect(to).toHaveValue('2');
    await expect(fields(page).locator('.accentf__on')).toHaveText('Sample entry');

    // Changing the heading changes the words on offer.
    await fields(page).locator('#f-title-en').fill('One two three four');
    await expect(from.locator('option')).toHaveCount(5); // "No highlight" + four words
    await expect(from.locator('option', { hasText: '4. four' })).toHaveCount(1);

    await from.selectOption('');
    await expect(fields(page).locator('.accentf__on')).toHaveCount(0);
    await expect(to).toHaveCount(0);
  });

  test('link: the picker fills the words and the address, and keeps words already written', async ({
    page,
  }) => {
    const href = fields(page).locator('#f-button-href');
    const target = fields(page).locator('#f-button-target');
    await expect(href).toHaveValue('/portfolio');

    // The pages are asked for only when the picker is reached.
    const asked = page.waitForResponse((res) => res.url().includes('/api/admin/linkables'));
    await target.focus();
    await asked;
    await expect(target.locator('option', { hasText: '(/about)' })).toHaveCount(1);

    // Words already written are kept; only the address moves.
    await target.selectOption('/about');
    await expect(href).toHaveValue('/about');
    await expect(fields(page).locator('#f-button-label-en')).toHaveValue('See the samples');

    // An address this site cannot have is said in words, on the box.
    await href.fill('https://example.com');
    await expect(href).toHaveAttribute('aria-invalid', 'true');
    await expect(fields(page).getByText('Use a page of this site (/about)')).toBeVisible();
    await href.fill('#apply');
    await expect(href).not.toHaveAttribute('aria-invalid', 'true');
  });

  test('link: with both labels empty, picking a page fills them in both languages', async ({
    page,
  }) => {
    await fields(page).locator('#f-button-label-en').fill('');
    await fields(page)
      .getByRole('group', { name: 'Sample button language' })
      .getByRole('radio', { name: 'Arabic' })
      .check();
    await fields(page).locator('#f-button-label-ar').fill('');
    const asked = page.waitForResponse((res) => res.url().includes('/api/admin/linkables'));
    await fields(page).locator('#f-button-target').focus();
    await asked;
    await fields(page).locator('#f-button-target').selectOption('/contact');
    await expect(fields(page).locator('#f-button-label-ar')).not.toHaveValue('');
    await fields(page)
      .getByRole('group', { name: 'Sample button language' })
      .getByRole('radio', { name: 'English' })
      .check();
    await expect(fields(page).locator('#f-button-label-en')).not.toHaveValue('');
  });

  test('clip: the window reads in words and draws, and a window too long says so', async ({
    page,
  }) => {
    await expect(fields(page).getByText('6.2 s to 7.9 s of showreel.mp4 (18.4 s)')).toBeVisible();
    await expect(fields(page).locator('svg.clipf__line')).toHaveAttribute('aria-hidden', 'true');
    await fields(page).locator('#f-clip-end').fill('17');
    await expect(fields(page).getByText('A clip plays at most 30 seconds.')).toHaveCount(0);
    await fields(page).locator('#f-clip-start').fill('0');
    await fields(page).locator('#f-clip-end').fill('40');
    await expect(fields(page).getByText(/A clip plays at most 30 seconds\./)).toBeVisible();
    await expect(
      fields(page).getByText('The video ends at 18.4 s, so the end is past it.'),
    ).toBeVisible();
  });

  test('a slug list keeps its order and names its buttons', async ({ page }) => {
    const list = fields(page).getByRole('group', { name: 'Sample projects beside it' });
    await expect(list.getByText('sample-one')).toBeVisible();
    await expect(list.getByText('2 of 2')).toBeVisible();
    await list.getByRole('button', { name: 'Move sample-two up' }).click();
    await expect(list.getByRole('button', { name: 'Move sample-two up' })).toBeDisabled();
    await list.getByRole('button', { name: 'Remove sample-one' }).click();
    await expect(list.getByText('sample-one')).toHaveCount(0);
    await expect(list.getByText('1 of 2')).toBeVisible();
  });

  test('axe: the new fields, in Both, with the link picker loaded', async ({ page }) => {
    await fields(page)
      .getByRole('group', { name: 'Editing language' })
      .getByRole('radio', { name: 'Both' })
      .check();
    const asked = page.waitForResponse((res) => res.url().includes('/api/admin/linkables'));
    await fields(page).locator('#f-button-target').focus();
    await asked;
    const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(results.violations, 'axe over the accent, link, slug list and clip').toEqual([]);
  });
});
