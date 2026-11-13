import AxeBuilder from '@axe-core/playwright';
import { randomBytes, randomInt } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { SKIP_REASON, authFile, staffEnv } from './staff';

/*
 * Merge duplicates, end to end (Admin v2 C12, crm.md §11 screen 9), on the real Worker and the
 * local stack, as the Admin (and, for the refusals, as Content Creator, SEO, Developer and
 * Sales, none of whom holds crm.contacts):
 *   the modal     "Merge duplicates" on the People list opens it; a pair says why in words and
 *                 never shows an e-mail address; axe with it open;
 *   not a dup     "Not a duplicate" takes the pair away, and the finder never offers it again;
 *   a merge       "Merge into older" shows what moves, "Swap, keep the other" swaps the two,
 *                 "Merge now" merges: the older record stays, the other is a 404;
 *   focus         every press keeps focus in the dialog (C12 review, C12-COR-2): the confirm
 *                 group's Cancel when it opens, the pair's "Merge into older" after Cancel,
 *                 the next pair's first action (or the empty state) when a pair leaves;
 *   a conflict    a merge at a version that moved on is a 409, and nothing is merged;
 *   refusals      every other role gets a 403 from the three routes.
 * Every contact is added through the real routes and named with this run's token (each pair
 * shares a phone number of its own, so the finder offers it among the phone matches, the
 * first it lists); nothing reads or writes the database directly.
 */

test.skip(!staffEnv(), SKIP_REASON);
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const RUN = randomBytes(4).toString('hex');

/** A Saudi mobile number of this run's own (E.164), so no other test's contacts share it. */
const phone = () => `+9665${String(randomInt(10_000_000, 99_999_999))}`;

async function csrf(page: Page): Promise<string> {
  const find = async () =>
    (await page.context().cookies()).find((c) => c.name === '__Host-csrf')?.value ?? '';
  if (!(await find())) await page.goto('/admin', { waitUntil: 'domcontentloaded' });
  return find();
}

/** The words on the focused element when it is inside the open dialog, else null. */
const focusedInDialog = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return el instanceof HTMLElement && el.closest('dialog[open]') !== null
      ? (el.textContent ?? '').trim()
      : null;
  });

async function visit(page: Page, path: string) {
  const res = await page.goto(path);
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  return res;
}

interface Added {
  id: string;
  name: string;
  email: string;
}

async function addContact(
  page: Page,
  label: string,
  extra: { name?: string; phone: string; company?: string },
): Promise<Added> {
  const name = extra.name ?? `E2E ${RUN} ${label}`;
  const email = `m-${label}-${RUN}@example.invalid`;
  const res = await page.request.post('/api/admin/crm/contacts', {
    headers: { 'x-csrf-token': await csrf(page) },
    data: {
      displayName: name,
      ...(extra.company ? { companyName: extra.company } : {}),
      channels: [
        { kind: 'email', value: email, isPrimary: true },
        { kind: 'phone', value: extra.phone, isPrimary: true },
      ],
    },
  });
  expect(res.status(), `add ${label}`).toBe(200);
  const { data } = (await res.json()) as { data: { id: string } };
  return { id: data.id, name, email };
}

async function pairs(page: Page): Promise<{ a: { id: string }; b: { id: string } }[]> {
  const res = await page.request.get('/api/admin/crm/duplicates');
  expect(res.status()).toBe(200);
  return ((await res.json()) as { data: { pairs: { a: { id: string }; b: { id: string } }[] } })
    .data.pairs;
}
const offered = (list: { a: { id: string }; b: { id: string } }[], x: string, y: string) =>
  list.some((p) => (p.a.id === x && p.b.id === y) || (p.a.id === y && p.b.id === x));

test.describe('as admin', () => {
  test.use({ storageState: authFile('admin') });
  test.describe.configure({ mode: 'serial' });

  test('the modal: Not a duplicate, then a merge into the older record', async ({ page }) => {
    // Two pairs, each on a phone number of its own. The first-added of each is the older.
    const shared = phone();
    const older = await addContact(page, 'keep', { phone: shared });
    const newer = await addContact(page, 'drop', { phone: shared });
    const twinPhone = phone();
    const twinCompany = `Twin Co ${RUN}`;
    const twinOne = await addContact(page, 'twin-1', {
      name: `E2E ${RUN} Twin`,
      phone: twinPhone,
      company: twinCompany,
    });
    const twinTwo = await addContact(page, 'twin-2', {
      name: `E2E ${RUN} Twin`,
      phone: twinPhone,
      company: twinCompany,
    });
    // Present first, then shape: the finder offers both pairs.
    const before = await pairs(page);
    expect(offered(before, older.id, newer.id)).toBe(true);
    expect(offered(before, twinOne.id, twinTwo.id)).toBe(true);

    await visit(page, '/admin/contacts');
    await page.getByRole('button', { name: 'Merge duplicates', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Merge duplicates' });
    await expect(dialog).toBeVisible();
    const pair = dialog.getByRole('listitem').filter({ hasText: older.name });
    await expect(pair).toHaveCount(1);
    await expect(pair).toContainText('Same phone number.');
    await expect(pair.getByRole('link', { name: newer.name, exact: true })).toBeVisible();
    const twins = dialog.getByRole('listitem').filter({ hasText: twinCompany });
    // Both rules found the twins (the reasons in the finder's order: by name).
    await expect(twins).toContainText('Same name at the same company. Same phone number.');
    // No contact detail on screen: the reasons are words, the people counts.
    const text = await dialog.innerText();
    for (const who of [older, newer, twinOne, twinTwo]) expect(text).not.toContain(who.email);
    expect(text).not.toContain(shared);
    const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(
      violations.map((v) => `${v.id}: ${v.help}`),
      'axe with the modal open',
    ).toEqual([]);

    // Not a duplicate: the pair goes, and is not offered again.
    await twins.getByRole('button', { name: 'Not a duplicate', exact: true }).click();
    await expect(page.locator('#admin-toasts')).toContainText('They will not be suggested again.');
    await expect(dialog.getByRole('listitem').filter({ hasText: twinCompany })).toHaveCount(0);
    // Focus went to the next pair's first action (the older and newer pair is still listed).
    await expect.poll(() => focusedInDialog(page)).toBe('Merge into older');
    expect(offered(await pairs(page), twinOne.id, twinTwo.id)).toBe(false);

    // A merge: the preview (focus on its Cancel), Cancel (focus back), the preview again, a
    // swap and back, then Merge now keeps the older record.
    const start = pair.getByRole('button', { name: 'Merge into older', exact: true });
    await start.click();
    const confirm = pair.getByRole('group', { name: 'Confirm the merge' });
    const cancel = confirm.getByRole('button', { name: 'Cancel', exact: true });
    await expect(cancel).toBeFocused();
    await cancel.click();
    await expect(confirm).toHaveCount(0);
    await expect(start).toBeFocused();
    await start.click();
    await expect(cancel).toBeFocused();
    await expect(confirm).toContainText(`${newer.name} is merged into ${older.name}.`);
    await expect(confirm).toContainText('notes, tasks and timeline move.');
    await confirm.getByRole('button', { name: 'Swap, keep the other', exact: true }).click();
    await expect(confirm).toContainText(`${older.name} is merged into ${newer.name}.`);
    await confirm.getByRole('button', { name: 'Swap, keep the other', exact: true }).click();
    await expect(confirm).toContainText(`${newer.name} is merged into ${older.name}.`);
    await confirm.getByRole('button', { name: 'Merge now', exact: true }).click();
    await expect(page.locator('#admin-toasts')).toContainText(`Merged into ${older.name}.`);
    await expect(dialog.getByRole('listitem').filter({ hasText: older.name })).toHaveCount(0);
    // Focus stays in the dialog: another pair's first action, or the empty state.
    await expect
      .poll(() => focusedInDialog(page))
      .toMatch(/^(Merge into older|No likely duplicates)$/);

    expect((await page.request.get(`/api/admin/crm/contacts/${newer.id}`)).status()).toBe(404);
    expect((await page.request.get(`/api/admin/crm/contacts/${older.id}`)).status()).toBe(200);
    expect(offered(await pairs(page), older.id, newer.id)).toBe(false);
  });

  test('a merge at a version that moved on is a 409, and nothing is merged', async ({ page }) => {
    const shared = phone();
    const one = await addContact(page, 'stale-1', { phone: shared });
    const two = await addContact(page, 'stale-2', { phone: shared });
    // A details change moves one's version to 2.
    const patch = await page.request.patch(`/api/admin/crm/contacts/${one.id}`, {
      headers: { 'x-csrf-token': await csrf(page) },
      data: { version: 1, title: 'Director' },
    });
    expect(patch.status()).toBe(200);
    const res = await page.request.post('/api/admin/crm/contacts/merge', {
      headers: { 'x-csrf-token': await csrf(page) },
      data: { keepId: one.id, keepVersion: 1, dropId: two.id, dropVersion: 1 },
    });
    expect(res.status()).toBe(409);
    expect((await page.request.get(`/api/admin/crm/contacts/${two.id}`)).status()).toBe(200);
  });
});

for (const role of ['content_creator', 'seo', 'developer', 'sales'] as const) {
  test.describe(`as ${role}`, () => {
    test.use({ storageState: authFile(role) });

    test('the merge routes are refused by the server', async ({ page }) => {
      const a = '11111111-1111-4111-8111-111111111111';
      const b = '22222222-2222-4222-8222-222222222222';
      expect((await page.request.get('/api/admin/crm/duplicates')).status()).toBe(403);
      for (const [api, data] of [
        ['/api/admin/crm/duplicates/dismiss', { a, b }],
        ['/api/admin/crm/contacts/merge', { keepId: a, keepVersion: 1, dropId: b, dropVersion: 1 }],
      ] as const) {
        const res = await page.request.post(api, {
          headers: { 'x-csrf-token': await csrf(page) },
          data,
        });
        expect(res.status(), api).toBe(403);
      }
    });
  });
}
