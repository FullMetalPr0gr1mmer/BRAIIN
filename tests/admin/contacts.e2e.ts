import AxeBuilder from '@axe-core/playwright';
import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { SKIP_REASON, authFile, staffEnv } from './staff';

/*
 * The contacts screens, end to end (Admin v2 C7, crm.md §11 screens 5 to 8, and the palette's
 * contacts), on the real Worker and the local stack, as the Admin (and, for the refusals, as
 * Content Creator, SEO, Developer and Sales, none of whom holds crm.contacts):
 *   the list     a filter writes the address; a whole e-mail finds its person through the
 *                blind index and never reaches the address or the page; the star; a bulk stage;
 *   the drawer   add by hand onto the contact's page; a taken e-mail is said, with an Open link;
 *                focus returns to the button;
 *   a contact    an Arabic name in its own direction; the reveal shows the e-mail and writes one
 *                audit row; a note; Details saved, then a conflict from another tab; a phone
 *                match confirmed; a new lead from the contact;
 *   the erasure  the preview (since C8b with the person's tasks counted), the reason, the
 *                second confirm; a 404 after, and the task gone with them;
 *   the palette  finds a person by name and by whole e-mail, typed key by key; no part of a
 *                typed term goes into a URL;
 *   refusals     every other role gets a 403 page (and API) for a real contact, with no name
 *                or company of theirs in it.
 * axe runs with each dialog open. Every contact it adds is named with this run's token and
 * added through the real routes; nothing reads or writes the database directly.
 */

test.skip(!staffEnv(), SKIP_REASON);
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const RUN = randomBytes(4).toString('hex');

async function axe(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(
    violations.map((v) => `${v.id} [${v.impact ?? 'n/a'}] ${v.nodes.length}x: ${v.help}`),
    `axe on ${label}`,
  ).toEqual([]);
}

/** The double-submit token the admin's own fetches send (the `__Host-csrf` cookie). */
async function csrf(page: Page): Promise<string> {
  const find = async () =>
    (await page.context().cookies()).find((c) => c.name === '__Host-csrf')?.value ?? '';
  if (!(await find())) await page.goto('/admin', { waitUntil: 'domcontentloaded' });
  return find();
}

/** Opens an admin page and waits until every island has hydrated (as leads.e2e.ts does). */
async function visit(page: Page, path: string, options?: Parameters<Page['goto']>[1]) {
  const res = await page.goto(path, options);
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  return res;
}

interface Added {
  id: string;
  name: string;
  email?: string;
  phone?: string;
}

/** A contact added by hand through the real route. */
async function addContact(
  page: Page,
  label: string,
  extra: { name?: string; email?: string | null; phone?: string; company?: string } = {},
): Promise<Added> {
  const name = extra.name ?? `E2E ${RUN} ${label}`;
  const email =
    extra.email === null ? undefined : (extra.email ?? `c-${label}-${RUN}@example.invalid`);
  const channels = [
    ...(email ? [{ kind: 'email', value: email, isPrimary: true }] : []),
    ...(extra.phone ? [{ kind: 'phone', value: extra.phone, isPrimary: true }] : []),
  ];
  const res = await page.request.post('/api/admin/crm/contacts', {
    headers: { 'x-csrf-token': await csrf(page) },
    data: {
      displayName: name,
      ...(extra.company ? { companyName: extra.company } : {}),
      ...(channels.length ? { channels } : {}),
    },
  });
  expect(res.status(), `add ${label}`).toBe(200);
  const { data } = (await res.json()) as { data: { id: string } };
  return {
    id: data.id,
    name,
    ...(email ? { email } : {}),
    ...(extra.phone ? { phone: extra.phone } : {}),
  };
}

async function contactOf(page: Page, id: string) {
  const res = await page.request.get(`/api/admin/crm/contacts/${id}`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { data: { contact: Record<string, unknown> } }).data.contact;
}

test.describe('as admin', () => {
  test.use({ storageState: authFile('admin') });
  // One at a time: the erasure and the bulk change move the counts the list's chips show.
  test.describe.configure({ mode: 'serial' });

  test('the list: filters in the address, never the search; the star; a bulk stage', async ({
    page,
  }) => {
    const one = await addContact(page, 'list-a');
    const two = await addContact(page, 'list-b');
    await visit(page, '/admin/contacts', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 1, name: 'Contacts' })).toBeVisible();
    await page.getByLabel('Owner', { exact: true }).selectOption('none');
    await expect(page).toHaveURL(/[?&]owner=none/);
    await page.getByLabel('Owner', { exact: true }).selectOption('');

    // A whole e-mail finds its person (the blind index); the address stays out of the URL,
    // and the page never prints it.
    const search = page.getByLabel('Search contacts');
    await search.fill(one.email!);
    await search.press('Enter');
    await expect(page.getByRole('link', { name: one.name, exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: two.name, exact: true })).toHaveCount(0);
    expect(page.url()).not.toContain('@');
    expect(page.url()).not.toContain(encodeURIComponent(one.email!));
    expect(await page.locator('main').innerText()).not.toContain(one.email!);

    // Half an address is refused under the box, the list left as it was.
    await search.fill(`c-list-a-${RUN}@`);
    await search.press('Enter');
    await expect(
      page.getByText('That looks like an e-mail address, but not a whole one.', { exact: false }),
    ).toBeVisible();

    // Both by name: the star, then a bulk stage.
    await search.fill(`E2E ${RUN} list-`);
    await search.press('Enter');
    await expect(page.getByRole('link', { name: two.name, exact: true })).toBeVisible();
    const star = page.getByRole('button', { name: `Star ${one.name}` });
    await star.click();
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await contactOf(page, one.id))['is_starred']).toBe(true);

    await page.getByRole('checkbox', { name: `Select ${one.name}` }).check();
    await page.getByRole('checkbox', { name: `Select ${two.name}` }).check();
    await page.getByLabel('New stage for the selected contacts').selectOption('client');
    await page.getByRole('button', { name: 'Move', exact: true }).click();
    await expect.poll(async () => (await contactOf(page, two.id))['stage']).toBe('client');
    await expect.poll(async () => (await contactOf(page, one.id))['stage']).toBe('client');
    await axe(page, 'the People list');
  });

  test('the drawer: a contact added by hand, and an e-mail that is taken', async ({ page }) => {
    const taken = await addContact(page, 'taken');
    await visit(page, '/admin/contacts');
    const open = page.getByRole('button', { name: 'Add contact', exact: true });
    await expect(open).toBeVisible();
    await open.click();
    const drawer = page.getByRole('dialog', { name: 'Add a contact' });
    await expect(drawer).toBeVisible();
    await axe(page, 'the add drawer');
    await drawer.getByRole('button', { name: 'Cancel' }).click();
    await expect(open).toBeFocused();

    await open.click();
    // The form's own check first.
    await drawer.getByRole('button', { name: 'Add contact', exact: true }).click();
    await expect(drawer.getByText('Give them a name.').first()).toBeVisible();

    await drawer.getByLabel(/^Name/).fill(`E2E ${RUN} drawer`);
    await drawer.getByLabel('E-mail').fill(taken.email!);
    await drawer.getByRole('button', { name: 'Add contact', exact: true }).click();
    await expect(drawer.getByText('Someone with this e-mail already exists.')).toBeVisible();
    await expect(drawer.getByRole('link', { name: 'Open them' })).toHaveAttribute(
      'href',
      `/admin/contacts/${taken.id}`,
    );

    await drawer.getByLabel('E-mail').fill(`c-drawer-${RUN}@example.invalid`);
    await drawer.getByRole('button', { name: 'Add contact', exact: true }).click();
    await page.waitForURL(/\/admin\/contacts\/[0-9a-f-]{36}(\?|$)/);
    await expect(page.locator('#admin-toasts')).toContainText('Contact added');
    await expect(page).toHaveURL(/\/admin\/contacts\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1, name: `E2E ${RUN} drawer` })).toBeVisible();
  });

  test('a contact: the reveal, a note, Details saved, then a conflict', async ({ page }) => {
    const person = await addContact(page, 'detail', { name: `نورة ${RUN}` });
    await visit(page, `/admin/contacts/${person.id}`, { waitUntil: 'networkidle' });
    const h1 = page.getByRole('heading', { level: 1, name: person.name });
    await expect(h1).toBeVisible();
    await expect(h1).toHaveAttribute('dir', 'auto');
    await expect(page).toHaveTitle(/^Contact/);
    expect(await page.content()).not.toContain(person.email!);
    await expect(page.locator('a[href^="mailto:"]')).toHaveCount(0);

    await page
      .getByRole('button', { name: 'Reveal contact details (this access is logged)' })
      .click();
    await expect(page.getByText(person.email!, { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Email', exact: true })).toHaveAttribute(
      'href',
      `mailto:${person.email}`,
    );
    const audit = await page.request.get(
      `/api/admin/audit?entityType=contact&entityId=${person.id}`,
    );
    expect(audit.status()).toBe(200);
    const entries = ((await audit.json()) as { data: { rows: { verb: string }[] } }).data.rows;
    expect(entries.filter((e) => e.verb === 'Revealed the e-mails and phones of')).toHaveLength(1);

    // A note: in the notes, and as a line in the timeline (never its words there).
    await page.getByLabel('New note').fill(`Met at the expo (${RUN})`);
    await page.getByRole('button', { name: 'Add note' }).click();
    await expect(page.getByText(`Met at the expo (${RUN})`)).toBeVisible();
    await expect(page.locator('.tl__t', { hasText: 'Note added' })).toBeVisible();

    // Details: an explicit Save.
    await page.getByLabel('Title', { exact: true }).fill('Head of marketing');
    await page.getByRole('button', { name: 'Save details' }).click();
    await expect(page.locator('#admin-toasts')).toContainText('Details saved.');
    await expect(page.locator('.admin-header .admin-sub')).toHaveText('Head of marketing');
    await expect(page.locator('.admin-header .admin-sub')).toHaveAttribute('dir', 'auto');
    await expect
      .poll(async () => (await contactOf(page, person.id))['title'])
      .toBe('Head of marketing');
    await axe(page, 'a contact with its details revealed');

    // Another tab changes the stage: this page's version is stale, and it says so.
    const stored = await contactOf(page, person.id);
    const behind = await page.request.patch(`/api/admin/crm/contacts/${person.id}`, {
      headers: { 'x-csrf-token': await csrf(page) },
      data: { version: stored['version'], stage: 'partner' },
    });
    expect(behind.status()).toBe(200);
    await page.getByLabel('City', { exact: true }).fill('Riyadh');
    await page.getByRole('button', { name: 'Save details' }).click();
    await expect(page.getByText('Someone else changed this. Refreshed.')).toBeVisible();
    await expect(page.getByLabel('Stage', { exact: true })).toHaveValue('partner');
  });

  test('a contact: a phone match confirmed, and a new lead', async ({ page }) => {
    const phone = `+9665${String(Date.now()).slice(-8)}`;
    const person = await addContact(page, 'phone', { phone });
    // A lead from another address with the same number arrives: linked by phone, to check.
    const lead = await page.request.post('/api/admin/leads', {
      headers: { 'x-csrf-token': await csrf(page) },
      data: {
        name: `E2E ${RUN} phone lead`,
        email: `l-phone-${RUN}@example.invalid`,
        phone,
        message: 'A call from a shared number.',
        channel: 'phone',
      },
    });
    expect(lead.status()).toBe(200);
    await visit(page, `/admin/contacts/${person.id}`, { waitUntil: 'networkidle' });
    await expect(
      page.getByText('Matched by phone number only. Is this the same person?'),
    ).toBeVisible();
    await page.getByRole('button', { name: /^Yes, same person/ }).click();
    await expect(page.getByText(/^Linked to this contact\./)).toBeVisible();
    await expect(
      page.getByText('Matched by phone number only. Is this the same person?'),
    ).toHaveCount(0);

    // A new lead from the contact: its e-mail and phone are the contact's, never sent.
    await page.getByRole('button', { name: 'New lead', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: /^New lead for / });
    await expect(drawer).toBeVisible();
    await axe(page, 'the new lead drawer');
    await drawer.getByLabel(/^Message/).fill('They asked for a quote by phone.');
    await drawer.getByRole('button', { name: 'Add lead', exact: true }).click();
    await page.waitForURL(/\/admin\/leads\/[0-9a-f-]{36}(\?|$)/);
    await expect(page.locator('#admin-toasts')).toContainText('Lead added');
  });

  test('the erasure: the preview, the reason, a second confirm; gone after', async ({ page }) => {
    const person = await addContact(page, 'erase');
    // (C8b) A task about them: the preview counts it, and it goes with them.
    const task = await page.request.post('/api/admin/crm/tasks', {
      headers: { 'x-csrf-token': await csrf(page) },
      data: {
        title: `E2E ${RUN} call before the erasure`,
        type: 'call',
        dueDate: '2030-01-15',
        dueTime: '10:00',
        contactId: person.id,
      },
    });
    expect(task.status()).toBe(200);
    const taskId = ((await task.json()) as { data: { id: string } }).data.id;
    expect((await page.request.get(`/api/admin/crm/tasks/${taskId}`)).status()).toBe(200);
    await visit(page, `/admin/contacts/${person.id}`, { waitUntil: 'networkidle' });
    await page.getByText('More actions').click();
    await page.getByRole('button', { name: 'Erase everything about them…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Erase everything about them' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/0 leads, 0 notes, 1 task, 1 e-mail or phone\./)).toBeVisible();
    await axe(page, 'the erase dialog');
    // No reason: refused before anything is sent.
    await dialog.getByRole('button', { name: 'Erase everything about them' }).click();
    await expect(dialog.getByText('Choose why their data is erased.')).toBeVisible();
    await dialog.getByLabel('Their request (DSAR)').check();
    await dialog.getByRole('button', { name: 'Erase everything about them' }).click();
    await expect(dialog.getByText('Are you sure?', { exact: false })).toBeVisible();
    await dialog.getByRole('button', { name: 'Yes, erase now' }).click();
    await page.waitForURL((url) => url.pathname === '/admin/contacts');
    await expect(page.locator('#admin-toasts')).toContainText('Everything about them was erased');
    const gone = await page.request.get(`/admin/contacts/${person.id}`);
    expect(gone.status()).toBe(404);
    // The task went with them (ON DELETE CASCADE): read before, gone after.
    expect((await page.request.get(`/api/admin/crm/tasks/${taskId}`)).status()).toBe(404);
  });

  test('the palette finds a person by name and by whole e-mail; no typed term reaches a URL', async ({
    page,
  }) => {
    // Typed key by key, each pause longer than the palette's 200 ms wait, so every part of a
    // term typed so far is searched (C7 review, C7-SEC-1: a fill() sends the whole value at
    // once, and a part of an address never reached the old check).
    test.slow();
    const person = await addContact(page, 'palette');
    const local = person.email!.split('@')[0]!;
    await visit(page, '/admin');
    const sent: { method: string; url: URL }[] = [];
    page.on('request', (request) =>
      sent.push({ method: request.method(), url: new URL(request.url()) }),
    );
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Search the admin' });
    await expect(palette).toBeVisible();
    const box = palette.getByRole('combobox', { name: 'Search the admin' });
    await box.pressSequentially(`E2E ${RUN} palette`, { delay: 250 });
    await expect(palette.getByRole('option', { name: person.name })).toBeVisible();
    await box.fill('');
    await box.pressSequentially(person.email!, { delay: 250 });
    await expect(palette.getByRole('option', { name: person.name })).toBeVisible();
    await expect(palette.getByRole('option', { name: /^See all results/ })).toHaveCount(0);
    await box.fill('');
    await box.pressSequentially('+966 55 123 4567', { delay: 250 });
    await expect(palette.getByRole('option', { name: /^See all results/ })).toHaveCount(0);

    // The parts were searched: in POST bodies, never in an address.
    const searches = sent.filter((r) => r.url.pathname === '/api/admin/search');
    expect(searches.length).toBeGreaterThan(5);
    expect(searches.filter((r) => r.method !== 'POST' || r.url.search !== '')).toEqual([]);
    const api = sent.filter((r) => r.url.pathname.startsWith('/api/')).map((r) => r.url);
    expect(api.filter((url) => url.searchParams.has('q')).map(String)).toEqual([]);
    expect(
      api
        .filter(
          (url) =>
            url.href.includes(local) ||
            url.href.includes(RUN) ||
            url.href.includes('@') ||
            url.href.includes('%40') ||
            url.search.includes('966') ||
            url.search.includes('4567'),
        )
        .map(String),
    ).toEqual([]);
  });
});

for (const role of ['content_creator', 'seo', 'developer', 'sales'] as const) {
  test.describe(`as ${role}`, () => {
    test.use({ storageState: authFile(role) });

    // A real contact, added as the Admin in this worker (so its name carries this worker's
    // RUN), for the refused role to try to open (C7 review, C7-TEST-1: an id that is no one's
    // proves nothing about what the page would have named).
    let person: Added;
    const company = `Refused Co ${randomBytes(4).toString('hex')}`;
    test.beforeAll(async ({ browser }) => {
      const context = await browser.newContext({ storageState: authFile('admin') });
      const page = await context.newPage();
      person = await addContact(page, `refused-${role}`, { company });
      await context.close();
    });

    test('every contacts page is refused by the server, naming no contact', async ({ page }) => {
      for (const path of ['/admin/contacts', `/admin/contacts/${person.id}`]) {
        const res = await visit(page, path);
        expect(res?.status(), path).toBe(403);
        await expect(page.locator('main .msg[data-kind="error"]').first()).toContainText(
          'Your role does not allow that.',
        );
        const html = await page.content();
        expect(html, path).not.toContain(person.name);
        expect(html, path).not.toContain(company);
        expect(html, path).not.toContain(RUN);
        expect(await page.locator('main').innerText(), path).not.toContain('E2E ');
      }
      for (const [method, api] of [
        ['post', '/api/admin/crm/contacts/query'],
        ['post', '/api/admin/crm/contacts/summary'],
        ['get', '/api/admin/crm/contacts/summary'],
        ['post', '/api/admin/crm/contacts/lookup'],
        ['get', `/api/admin/crm/contacts/${person.id}`],
      ] as const) {
        const res =
          method === 'post'
            ? await page.request.post(api, {
                headers: { 'x-csrf-token': await csrf(page) },
                data: api.endsWith('lookup') ? { q: person.name } : {},
              })
            : await page.request.get(api);
        expect(res.status(), api).toBe(403);
        const body = await res.text();
        expect(body, api).not.toContain(person.name);
        expect(body, api).not.toContain(company);
      }
    });
  });
}
