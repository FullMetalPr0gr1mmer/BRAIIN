import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { SKIP_REASON, authFile, staffEnv } from './staff';

// The activity log (Admin v2 U13) in a real browser, signed in as the two roles that read it:
// every view is a URL (the kind chips, the person and the days, the pager); the chain line
// says whether the newest entries link up; the page loads no island of its own (the shell's
// chrome only); and the Export link answers a no-store CSV attachment three times an hour,
// after which a click comes back to the page with the limit explained. The refusal of the
// other roles (403 from the page itself) is tests/admin/refusals.e2e.ts; the page and a
// filtered view are in the per-role sweep (routes.ts), which checks axe, CSP, overflow and
// that no style attribute is served.
//
// Each role's export budget is spent by the export test (three an hour per person): a CI
// retry inside the hour finds it spent, and checks the refusal only.

test.skip(!staffEnv(), SKIP_REASON);
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function open(page: Page, path: string) {
  const response = await page.goto(path, { waitUntil: 'networkidle' });
  expect(response?.status(), path).toBe(200);
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
}

async function expectNoAxeViolations(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(
    violations.map((v) => `${v.id} [${v.impact ?? 'n/a'}] ${v.nodes.length}x: ${v.help}`),
    label,
  ).toEqual([]);
}

/** The islands a page hydrates, by the component each one loads. */
async function islands(page: Page): Promise<string[]> {
  return page
    .locator('astro-island')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('component-url') ?? ''));
}

for (const role of ['admin', 'developer'] as const) {
  test.describe(`as ${role}`, () => {
    test.use({ storageState: authFile(role) });

    test('the log names people, keeps every filter in the URL and checks the chain', async ({
      page,
    }) => {
      await open(page, '/admin/audit');
      await expect(
        page.getByRole('heading', { level: 1, name: 'Activity log', exact: true }),
      ).toBeVisible();
      await expect(page.locator('.admin-sub').first()).toHaveText(
        'Who changed what, and when. Kept permanently and tamper-evident.',
      );
      // Every role signed in during the setup, so the log holds entries: a table with its
      // caption, Who and When columns, and the chain line over the newest entries.
      const table = page.getByRole('table', { name: 'Activity, newest first', exact: true });
      await expect(table).toBeVisible();
      await expect(table.getByRole('columnheader')).toHaveText(['Who', 'What', 'Details', 'When']);
      await expect(table.locator('tbody tr').first().locator('.cell-person')).toBeVisible();
      await expect(table.locator('tbody time').first()).toHaveAttribute('datetime', /^\d{4}-/);
      await expect(page.locator('.act-note').first()).toHaveText(
        /The latest \d+ entries link up: none has been removed or moved\./,
      );
      // No island of its own: the shell's chrome is the page's only one, as on Search.
      const own = await islands(page);
      await open(page, '/admin/search');
      expect(own).toEqual(await islands(page));
      await open(page, '/admin/audit');

      // A kind chip is a link that keeps the other filters and marks itself current.
      await page
        .getByRole('navigation', { name: 'Filter by kind of activity' })
        .getByRole('link', { name: 'Users', exact: true })
        .click();
      await expect(page).toHaveURL(/\/admin\/audit\?kind=users$/);
      await expect(
        page.getByRole('navigation', { name: 'Filter by kind of activity' }).getByRole('link', {
          name: 'Users',
          exact: true,
        }),
      ).toHaveAttribute('aria-current', 'page');
      // The setup's sign-ins are Users activity: "Signed in", badged User.
      await expect(table.getByText('Signed in').first()).toBeVisible();

      // A person and a range of days, through the GET form: the kind is kept.
      // Every control is found inside the filter form, by its exact name: page-wide, 'To'
      // also matches the palette's "Go to" group and a person whose name holds "to".
      const filters = page.locator('form.act-filters');
      const person = filters.getByLabel('Person', { exact: true });
      const firstPerson = await person.locator('option').nth(1).getAttribute('value');
      expect(firstPerson).toMatch(/^[0-9a-f-]{36}$/);
      await person.selectOption(firstPerson!);
      await filters.getByLabel('From', { exact: true }).fill('2026-01-01');
      await filters.getByLabel('To', { exact: true }).fill('2099-12-31');
      await filters.getByRole('button', { name: 'Apply', exact: true }).click();
      await expect(page).toHaveURL(
        new RegExp(`kind=users&actor=${firstPerson}&from=2026-01-01&to=2099-12-31$`),
      );
      await expect(
        page.locator('form.act-filters').getByLabel('Person', { exact: true }),
      ).toHaveValue(firstPerson!);
      await expectNoAxeViolations(page, `${role}: the activity log, filtered`);

      // A range with nothing in it says so; Clear filters goes back to everything.
      await open(page, '/admin/audit?from=2000-01-01&to=2000-01-02');
      await expect(
        page.locator('main .empty').getByText('No activity matches these filters', { exact: true }),
      ).toBeVisible();
      await page
        .locator('form.act-filters')
        .getByRole('link', { name: 'Clear filters', exact: true })
        .click();
      await expect(page).toHaveURL(/\/admin\/audit$/);

      // A page past the end shows the last one, never an empty table under a range.
      await open(page, '/admin/audit?page=9999');
      await expect(page.locator('.tbl__range')).toHaveText(/^\d[\d,]* to [\d,]+ of [\d,]+$/);
      await expect(page.locator('main .msg[data-kind="error"]')).toHaveCount(0);
    });

    test('the export: a no-store CSV attachment, three an hour, then the limit explained', async ({
      page,
    }) => {
      await open(page, '/admin/audit');
      const exportLink = page.locator('.admin-header').getByRole('link', { name: /^Export/ });
      await expect(exportLink).toHaveAttribute('href', '/api/admin/audit/export');

      // Spend the hour's budget: three files, then a 429 (a retry finds it spent already).
      const files: APIResponse[] = [];
      let refused: APIResponse | null = null;
      for (let i = 0; i < 4 && !refused; i += 1) {
        const res = await page.request.get('/api/admin/audit/export?kind=users');
        if (res.status() === 200) files.push(res);
        else refused = res;
      }
      expect(refused?.status()).toBe(429);
      expect(files.length).toBeLessThanOrEqual(3);
      if (test.info().retry === 0) expect(files).toHaveLength(3);
      for (const file of files.slice(0, 1)) {
        expect(file.headers()['content-type']).toBe('text/csv; charset=utf-8');
        expect(file.headers()['content-disposition']).toMatch(
          /^attachment; filename="activity-\d{4}-\d{2}-\d{2}(-first-\d+)?\.csv"$/,
        );
        expect(file.headers()['cache-control']).toContain('no-store');
        const text = await file.text();
        expect(text.replace(/^﻿/, '').split('\r\n')[0]).toBe(
          '"when_utc","when_riyadh","who","role","kind","what","item_type","item_id","changed_fields"',
        );
        expect(text).not.toMatch(/prev_hash|"hash"/);
      }

      // The budget is spent: following the link comes back to the page, filters kept.
      await open(page, '/admin/audit?kind=users');
      await page
        .locator('.admin-header')
        .getByRole('link', { name: /^Export/ })
        .click();
      await expect(page).toHaveURL(/\/admin\/audit\?kind=users&export=limit$/);
      await expect(page.locator('.act-note').first()).toContainText(
        'The activity log can be exported three times an hour.',
      );
      await expectNoAxeViolations(page, `${role}: the export limit`);
    });
  });
}
