import AxeBuilder from '@axe-core/playwright';
import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { SKIP_REASON, authFile, staffEnv } from './staff';

/*
 * Import contacts, end to end (Admin v2 C15, crm.md §12), on the real Worker and the local
 * stack. As the Admin: the People list's Import link; the template (an attachment, the heading
 * row); a file read in the browser (people counted, a column left out named by number); the
 * statement must be ticked; the import (added, already a contact, repeated in the file, a row
 * with no lawful basis named by number); the recent imports; the outcome audit row; importing
 * the same file again adds nobody. As Content Creator, SEO, Developer and Sales: the page is a
 * 403 and every import route refuses. Every person is named with this run's token, the file is
 * made here, and nothing reads or writes the database directly.
 */

test.skip(!staffEnv(), SKIP_REASON);
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const RUN = randomBytes(4).toString('hex');
const API = '/api/admin/crm/contacts/import';

async function axe(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(
    violations.map((v) => `${v.id} [${v.impact ?? 'n/a'}] ${v.nodes.length}x: ${v.help}`),
    `axe on ${label}`,
  ).toEqual([]);
}

async function csrf(page: Page): Promise<string> {
  const find = async () =>
    (await page.context().cookies()).find((c) => c.name === '__Host-csrf')?.value ?? '';
  if (!(await find())) await page.goto('/admin', { waitUntil: 'domcontentloaded' });
  return find();
}

async function visit(page: Page, path: string) {
  const res = await page.goto(path);
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  return res;
}

test.describe('as admin', () => {
  test.use({ storageState: authFile('admin') });
  test.describe.configure({ mode: 'serial' });

  const existing = `already-${RUN}@example.invalid`;
  const fresh = `imp-one-${RUN}@example.invalid`;
  const file = [
    'Name,Email,Phone,Notes,Lawful basis',
    `E2E ${RUN} Import One,${fresh},,a private note,consent`,
    `E2E ${RUN} Already,${existing},,,contract`,
    `E2E ${RUN} Repeat,${fresh},,,consent`,
    ',,,,',
    `E2E ${RUN} No Basis,nb-${RUN}@example.invalid,,,`,
  ].join('\r\n');

  test('the template is an attachment holding the heading row', async ({ page }) => {
    const res = await page.request.get(`${API}/template`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers()['content-disposition']).toContain('attachment');
    expect(res.headers()['cache-control']).toContain('no-store');
    const text = (await res.body()).toString('utf8');
    expect(text).toContain('"name","email","phone"');
    expect(text).toContain('"lawful_basis"');
  });

  test('a file imported: added, already a contact, repeated, a row refused by number', async ({
    page,
  }) => {
    // Someone already in Contacts, added by hand through the real route.
    const added = await page.request.post('/api/admin/crm/contacts', {
      headers: { 'x-csrf-token': await csrf(page) },
      data: {
        displayName: `E2E ${RUN} Existing`,
        channels: [{ kind: 'email', value: existing, isPrimary: true }],
      },
    });
    expect(added.status()).toBe(200);

    await visit(page, '/admin/contacts');
    await page.getByRole('link', { name: 'Import', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/contacts\/import$/);
    await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
    await expect(page.getByRole('heading', { level: 1, name: 'Import contacts' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Download the template' })).toHaveAttribute(
      'href',
      `${API}/template`,
    );
    await axe(page, 'Import contacts');

    await page.getByLabel('Choose a CSV file').setInputFiles({
      name: 'people.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(file, 'utf8'),
    });
    await expect(
      page.getByText(
        'Found 4 people in Name, E-mail, Phone, Lawful basis. Column 4 will be left out.',
      ),
    ).toBeVisible();

    // The statement first.
    await page.getByRole('button', { name: 'Import 4 people' }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Tick the statement to import.' }),
    ).toBeVisible();
    await page.getByLabel('I confirm we may hold each person’s details', { exact: false }).check();
    await page.getByRole('button', { name: 'Import 4 people' }).click();

    await expect(page.getByRole('heading', { name: 'The import is done' })).toBeVisible();
    const result = page.locator('.imp__result');
    await expect(result).toContainText('Added 1 person.');
    await expect(result).toContainText('Already contacts, so left as they are: 1 row (3).');
    await expect(result).toContainText('Repeated in the file, so added once: row 4 repeats row 2.');
    await expect(result).toContainText('Not imported: 1 row.');
    await expect(result).toContainText('Row 6: no lawful basis.');
    // No address, no left-out column, nothing a row held, in the result or the URL.
    await expect(result).not.toContainText(fresh);
    expect(page.url()).not.toContain('@');
    expect(await page.content()).not.toContain('a private note');
    await axe(page, 'Import contacts, the result');

    // The recent imports, newest first: this one, by "You", done.
    const first = page.locator('table.data tbody tr').first();
    await expect(first).toContainText('You');
    await expect(first).toContainText('Done');

    // The outcome audit row, on the batch.
    const list = await page.request.get(API);
    expect(list.status()).toBe(200);
    const batches = ((await list.json()) as { data: { batches: { id: string }[] } }).data.batches;
    const batchId = batches[0]?.id;
    expect(batchId).toBeTruthy();
    const audit = await page.request.get(
      `/api/admin/audit?entityType=contact_import&entityId=${batchId}`,
    );
    expect(audit.status()).toBe(200);
    const rows = ((await audit.json()) as { data: { rows: { verb: string }[] } }).data.rows;
    expect(rows.filter((r) => r.verb === 'Imported')).toHaveLength(1);

    // The imported person is a contact, found by name.
    const lookup = await page.request.post('/api/admin/crm/contacts/lookup', {
      headers: { 'x-csrf-token': await csrf(page) },
      data: { q: `E2E ${RUN} Import One` },
    });
    const hits = ((await lookup.json()) as { data: { contacts: unknown[] } }).data.contacts;
    expect(hits).toHaveLength(1);
  });

  test('the same file again adds nobody', async ({ page }) => {
    await visit(page, '/admin/contacts/import');
    await page.getByLabel('Choose a CSV file').setInputFiles({
      name: 'people.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(file, 'utf8'),
    });
    await page.getByLabel('I confirm we may hold each person’s details', { exact: false }).check();
    await page.getByRole('button', { name: 'Import 4 people' }).click();
    await expect(page.getByRole('heading', { name: 'The import is done' })).toBeVisible();
    const result = page.locator('.imp__result');
    await expect(result).toContainText('Added 0 people.');
    await expect(result).toContainText(
      'Already contacts, so left as they are: 3 rows (2, 3 and 4).',
    );
  });

  test('a file the browser cannot use is said before anything is sent', async ({ page }) => {
    await visit(page, '/admin/contacts/import');
    await page.getByLabel('Choose a CSV file').setInputFiles({
      name: 'people.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(`Name,Email\nE2E ${RUN},x-${RUN}@example.invalid\n`, 'utf8'),
    });
    await expect(
      page.getByRole('alert').filter({ hasText: 'no lawful_basis column' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
  });
});

for (const role of ['content_creator', 'seo', 'developer', 'sales'] as const) {
  test.describe(`as ${role}`, () => {
    test.use({ storageState: authFile(role) });

    test('the import page and every import route are refused', async ({ page }) => {
      const res = await visit(page, '/admin/contacts/import');
      expect(res?.status()).toBe(403);
      await expect(page.locator('main .msg[data-kind="error"]').first()).toContainText(
        'Your role does not allow that.',
      );
      await expect(page.getByLabel('Choose a CSV file')).toHaveCount(0);
      expect((await page.request.get(API)).status()).toBe(403);
      expect((await page.request.get(`${API}/template`)).status()).toBe(403);
      const open = await page.request.post(API, {
        headers: { 'x-csrf-token': await csrf(page) },
        data: { step: 'open', rows: 1, bytes: 10, attested: true },
      });
      expect(open.status()).toBe(403);
    });
  });
}
