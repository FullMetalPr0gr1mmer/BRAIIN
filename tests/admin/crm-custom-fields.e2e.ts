import AxeBuilder from '@axe-core/playwright';
import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { SKIP_REASON, authFile, staffEnv } from './staff';

/*
 * Custom contact fields and the contacts' half of CRM settings, end to end (Admin v2 C9b,
 * crm.md §4.7 and §11 screens 6, 7 and 11), on the real Worker and the local stack, as the
 * Admin (crm.settings, crm.contacts and crm.erase are Admin's alone):
 *   settings   Add field, a label (the key follows it), the type Date, Save fields; the row then
 *              says the type and key are fixed; the read-only Contact stages card; axe;
 *   a contact  Details draws the field; a date saved through it reaches the contact; a date
 *              that does not exist is refused by the API (422); Add contact draws it too;
 *   removal    Remove, Save fields, the confirm ("Remove and save"): the contact's value is gone;
 *   erasure    Data and privacy: "Erase a person's data", find the contact by name, the pick
 *              opens the erase dialog with its preview (cancelled: nothing is erased here; the
 *              erasure itself is contacts.e2e.ts's).
 * Every field and contact is named with this run's token, and the field is removed again, so a
 * parallel spec's contact page shows no field of this run for long. Nothing reads or writes the
 * database directly.
 */

test.skip(!staffEnv(), SKIP_REASON);
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const RUN = randomBytes(4).toString('hex');
const LABEL = `Renewal ${RUN}`;
const KEY = `renewal_${RUN}`;

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

async function settingsNow(page: Page) {
  const res = await page.request.get('/api/admin/crm/settings');
  expect(res.status()).toBe(200);
  return (
    (await res.json()) as {
      data: { settings: { version: number; customFields: { key: string }[] } };
    }
  ).data.settings;
}

async function contactCustom(page: Page, id: string): Promise<Record<string, unknown>> {
  const res = await page.request.get(`/api/admin/crm/contacts/${id}`);
  expect(res.status()).toBe(200);
  const { data } = (await res.json()) as { data: { contact: { custom: Record<string, unknown> } } };
  return data.contact.custom;
}

test.describe('as admin', () => {
  test.use({ storageState: authFile('admin') });
  test.describe.configure({ mode: 'serial' });

  let contactId = '';
  const contactName = `E2E ${RUN} custom`;

  test('CRM settings: a date field added, its key from its label, then fixed', async ({ page }) => {
    const before = await settingsNow(page);
    const n = before.customFields.length + 1;
    await visit(page, '/admin/crm/settings');
    await expect(page.getByRole('heading', { level: 2, name: 'Custom fields' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Contact stages' })).toBeVisible();
    await expect(page.getByText('Worked with us more than 6 months ago.')).toBeVisible();

    await page.getByRole('button', { name: 'Add field' }).click();
    await page.getByRole('textbox', { name: `Label of field ${n}`, exact: true }).fill(LABEL);
    await page
      .getByRole('combobox', { name: `Type of field ${n}`, exact: true })
      .selectOption('date');
    // The key followed the label.
    await expect(page.getByRole('textbox', { name: `Key of field ${n}`, exact: true })).toHaveValue(
      KEY,
    );
    await axe(page, 'CRM settings with a new field');
    await page.getByRole('button', { name: 'Save fields' }).click();
    await expect(page.locator('#admin-toasts')).toContainText('Custom fields saved.');
    // Saved: the type and key are words now, no longer boxes.
    await expect(page.getByText(`Date, saved as ${KEY}`)).toBeVisible();
    await expect(page.getByRole('textbox', { name: `Key of field ${n}`, exact: true })).toHaveCount(
      0,
    );
    const after = await settingsNow(page);
    expect(after.customFields.map((f) => f.key)).toContain(KEY);
    expect(after.version).toBeGreaterThan(before.version);
  });

  test('a contact: the field under Details, a date saved; a day that does not exist refused', async ({
    page,
  }) => {
    const add = await page.request.post('/api/admin/crm/contacts', {
      headers: { 'x-csrf-token': await csrf(page) },
      data: { displayName: contactName },
    });
    expect(add.status()).toBe(200);
    contactId = ((await add.json()) as { data: { id: string } }).data.id;

    await visit(page, `/admin/contacts/${contactId}`);
    const box = page.getByLabel(LABEL, { exact: true });
    await expect(box).toHaveAttribute('type', 'date');
    await box.fill('2027-01-31');
    await page.getByRole('button', { name: 'Save details' }).click();
    await expect(page.locator('#admin-toasts')).toContainText('Details saved.');
    expect((await contactCustom(page, contactId))[KEY]).toBe('2027-01-31');

    // The API refuses what the field cannot hold, and the value stays.
    const res = await page.request.get(`/api/admin/crm/contacts/${contactId}`);
    const version = ((await res.json()) as { data: { contact: { version: number } } }).data.contact
      .version;
    const bad = await page.request.patch(`/api/admin/crm/contacts/${contactId}`, {
      headers: { 'x-csrf-token': await csrf(page) },
      data: { version, custom: { [KEY]: '2027-02-30' } },
    });
    expect(bad.status()).toBe(422);
    expect((await contactCustom(page, contactId))[KEY]).toBe('2027-01-31');
  });

  test('Add contact draws the field', async ({ page }) => {
    await visit(page, '/admin/contacts');
    await page.getByRole('button', { name: 'Add contact', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Add a contact' });
    await expect(drawer.getByLabel(LABEL, { exact: true })).toHaveAttribute('type', 'date');
    await axe(page, 'Add contact with a custom field');
    await drawer.getByRole('button', { name: 'Cancel' }).click();
  });

  test('Data and privacy: find a person, and the erase dialog opens on them', async ({ page }) => {
    await visit(page, '/admin/crm/settings');
    await expect(page.getByRole('heading', { level: 2, name: 'Data and privacy' })).toBeVisible();
    await expect(
      page.getByText(
        /^Leads are kept \d+ months after they arrive, and contacts \d+ months after their last activity\.$/,
      ),
    ).toBeVisible();
    await page.getByRole('button', { name: "Erase a person's data" }).click();
    const finder = page.getByRole('dialog', { name: "Erase a person's data" });
    await finder.getByLabel('Who', { exact: true }).fill(contactName);
    const pick = finder.getByRole('button', { name: contactName });
    await expect(pick).toBeVisible();
    await axe(page, 'the erasure finder with a result');
    await pick.click();
    const erase = page.getByRole('dialog', { name: 'Erase everything about them' });
    await expect(erase).toBeVisible();
    await expect(erase.getByText(`${contactName}:`, { exact: false })).toBeVisible();
    await axe(page, 'the erase dialog from CRM settings');
    await erase.getByRole('button', { name: 'Cancel' }).click();
    await expect(erase).toHaveCount(0);
  });

  test('removing the field, after the confirm, takes the contact’s value', async ({ page }) => {
    await visit(page, '/admin/crm/settings');
    await page.getByRole('button', { name: `Remove: ${LABEL}` }).click();
    await page.getByRole('button', { name: 'Save fields' }).click();
    await page.getByRole('button', { name: 'Remove and save' }).click();
    await expect(page.locator('#admin-toasts')).toContainText('Custom fields saved.');
    expect((await settingsNow(page)).customFields.map((f) => f.key)).not.toContain(KEY);
    expect(await contactCustom(page, contactId)).not.toHaveProperty(KEY);
  });
});
