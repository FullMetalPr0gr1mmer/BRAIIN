import AxeBuilder from '@axe-core/playwright';
import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { SKIP_REASON, authFile, staffEnv } from './staff';

/*
 * Companies, end to end (Admin v2 C11, crm.md §5.3 and §11 screens 5 and 6), on the real
 * Worker and the local stack, as the Admin and as Sales (crm.contacts since C10b, the C10b + C11
 * integration), and, for the refusals, as Content Creator, SEO and Developer, none of whom
 * holds crm.contacts:
 *   the tab      People | Companies; add in the drawer (a website that is not https is said
 *                under the field); found by the search; opened by its id; a change saved, then
 *                a conflict from another tab refreshes the form; removed after a confirm;
 *   a contact    "Create company from this name" links the typed name; the Details field is
 *                read-only while linked; a second contact linked through the search; a rename
 *                reaches both; Unlink keeps the name as text;
 *   arrival      two inquiries naming one company (folded alike) share it, and it learns their
 *                e-mail domain; a third with no company from that domain joins it only once a
 *                person has edited the company (C11 review: an auto-company's domain collects
 *                no one); the drawer says a domain is held, and the Admin forgets it, after which
 *                that domain joins no one;
 *   as sales     the tab opens, a company is added and found; forgetting a domain (crm.settings)
 *                is refused;
 *   refusals     every other role gets a 403 page (and API) naming no company.
 * axe runs with the drawer open. Everything is named with this run's token and made through
 * the real routes; nothing reads or writes the database directly.
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

/** Opens an admin page and waits until every island has hydrated (as contacts.e2e.ts does). */
async function visit(page: Page, path: string, options?: Parameters<Page['goto']>[1]) {
  const res = await page.goto(path, options);
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  return res;
}

interface Company {
  id: string;
  name: string;
  version: number;
  contacts: number;
  auto: boolean;
  domain: 'learnt' | 'joins' | null;
}

/** A company added through the real route. */
async function addCompany(page: Page, name: string): Promise<Company> {
  const res = await page.request.post('/api/admin/crm/companies', {
    headers: { 'x-csrf-token': await csrf(page) },
    data: { name },
  });
  expect(res.status(), `add ${name}`).toBe(200);
  return ((await res.json()) as { data: Company }).data;
}

async function companyOf(page: Page, id: string) {
  const res = await page.request.get(`/api/admin/crm/companies/${id}`);
  expect(res.status(), `read ${id}`).toBe(200);
  return (
    (await res.json()) as {
      data: { company: Company; contacts: { id: string; display_name: string }[] };
    }
  ).data;
}

async function findCompanies(page: Page, q: string): Promise<Company[]> {
  const res = await page.request.post('/api/admin/crm/companies/query', {
    headers: { 'x-csrf-token': await csrf(page) },
    data: { q },
  });
  expect(res.status(), `query ${q}`).toBe(200);
  return ((await res.json()) as { data: { rows: Company[] } }).data.rows;
}

/** A contact added by hand through the real route. */
async function addContact(page: Page, name: string, company?: string): Promise<string> {
  const res = await page.request.post('/api/admin/crm/contacts', {
    headers: { 'x-csrf-token': await csrf(page) },
    data: { displayName: name, ...(company ? { companyName: company } : {}) },
  });
  expect(res.status(), `add ${name}`).toBe(200);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

/** An inquiry added by hand: the same door as the public form (crm_ingest_lead). */
async function addLead(page: Page, label: string, email: string, company?: string) {
  const res = await page.request.post('/api/admin/leads', {
    headers: { 'x-csrf-token': await csrf(page) },
    data: {
      name: `E2E ${RUN} ${label}`,
      message: 'A test inquiry for companies.',
      channel: 'phone',
      email,
      ...(company ? { company } : {}),
    },
  });
  expect(res.status(), `lead ${label}`).toBe(200);
}

const companyCard = (page: Page) =>
  page.locator('section.card').filter({
    has: page.getByRole('heading', { level: 2, name: 'Company', exact: true }),
  });

test.describe('as admin', () => {
  test.use({ storageState: authFile('admin') });
  test.describe.configure({ mode: 'serial' });

  test('the Companies tab: add in the drawer, find, change, a conflict refreshes, remove', async ({
    page,
  }) => {
    const name = `E2E ${RUN} Tab Co`;
    await visit(page, '/admin/contacts/companies');
    await expect(page.getByRole('heading', { level: 1, name: 'Companies' })).toBeVisible();
    const tabs = page.getByRole('navigation', { name: 'Contacts sections' });
    await expect(tabs.getByRole('link', { name: 'People', exact: true })).toBeVisible();
    await expect(tabs.getByRole('link', { name: 'Companies', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );

    // Add: a website that is not https is said under its field, nothing is sent.
    await page.getByRole('button', { name: 'Add company', exact: true }).click();
    const fresh = page.getByRole('dialog', { name: 'New company' });
    await expect(fresh).toBeVisible();
    await axe(page, 'the new company drawer');
    await fresh.getByRole('textbox', { name: /^Name/ }).fill(name);
    const website = fresh.getByRole('textbox', { name: 'Website', exact: true });
    await website.fill('http://e2e.example');
    await fresh.getByRole('button', { name: 'Add company', exact: true }).click();
    await expect(fresh.locator('.f__err')).toHaveText('Use an address that starts with https://');
    await expect(website).toHaveAttribute('aria-invalid', 'true');
    await website.fill(`https://e2e-${RUN}.example/about`);
    await fresh.getByRole('textbox', { name: 'City', exact: true }).fill('جدة');
    await fresh.getByRole('button', { name: 'Add company', exact: true }).click();
    await expect(fresh).toBeHidden();
    await expect(page.locator('#admin-toasts')).toContainText('Company added.');

    // Found by the search (a POST body: the term never reaches the address).
    const search = page.getByLabel('Search companies');
    await search.fill(`${RUN} tab`);
    await search.press('Enter');
    const link = page.getByRole('link', { name, exact: true });
    await expect(link).toBeVisible();
    expect(page.url()).not.toContain(RUN);
    await expect(page.getByRole('cell', { name: `e2e-${RUN}.example` })).toBeVisible();
    const href = await link.getAttribute('href');
    expect(href).toMatch(/^\/admin\/contacts\/companies\?company=[0-9a-f-]{36}$/);
    const id = href!.split('=')[1]!;
    const before = (await companyOf(page, id)).company;
    expect(before.auto).toBe(false);

    // Opened by its id: the drawer reads it.
    await link.click();
    await page.waitForURL((url) => url.searchParams.get('company') === id);
    const drawer = page.getByRole('dialog', { name });
    await expect(drawer).toBeVisible();
    const city = drawer.getByRole('textbox', { name: 'City', exact: true });
    await expect(city).toHaveValue('جدة');

    // Someone else saves first: the drawer's Save is a 409 that shows the company as it is.
    const moved = await page.request.patch(`/api/admin/crm/companies/${id}`, {
      headers: { 'x-csrf-token': await csrf(page) },
      data: { version: before.version, city: 'Riyadh' },
    });
    expect(moved.status()).toBe(200);
    await city.fill('Dammam');
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      drawer.getByRole('alert').filter({ hasText: 'Someone else changed this. Refreshed.' }),
    ).toBeVisible();
    await expect(city).toHaveValue('Riyadh');
    // The next Save carries the new version.
    await city.fill('Dammam');
    await drawer.getByLabel('Stage').selectOption('client');
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(drawer.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
    const after = (await companyOf(page, id)).company as Company & {
      city: string;
      stage: string;
    };
    expect([after.city, after.stage, after.version]).toEqual(['Dammam', 'client', 3]);

    // Removed after a confirm.
    await drawer.getByRole('button', { name: 'Remove', exact: true }).click();
    const confirm = page.getByRole('dialog').filter({ hasText: `Remove ${name}?` });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Remove company' }).click();
    await expect(drawer).toBeHidden();
    await expect(page.locator('#admin-toasts')).toContainText('Company removed.');
    expect((await page.request.get(`/api/admin/crm/companies/${id}`)).status()).toBe(404);
  });

  test("a contact's company: create from the typed name, link by search, rename, unlink", async ({
    page,
  }) => {
    const typed = `E2E ${RUN} Typed Co`;
    const first = await addContact(page, `E2E ${RUN} typed person`, typed);
    const second = await addContact(page, `E2E ${RUN} search person`);

    await visit(page, `/admin/contacts/${first}`);
    let card = companyCard(page);
    await expect(card).toContainText(`Typed as ${typed}, not linked to a company record yet.`);
    const details = page.getByRole('textbox', { name: 'Company', exact: true });
    await expect(details).toBeEditable();
    await card.getByRole('button', { name: 'Create company from this name' }).click();
    await expect(page.locator('#admin-toasts')).toContainText('Company linked.');
    await expect(card.locator('strong')).toHaveText(typed);
    const open = card.getByRole('link', { name: 'Open in Companies' });
    const href = await open.getAttribute('href');
    expect(href).toMatch(/^\/admin\/contacts\/companies\?company=[0-9a-f-]{36}$/);
    const companyId = href!.split('=')[1]!;
    await expect(details).not.toBeEditable();
    await expect(
      page.getByText('Linked to a company record. Rename it there, or unlink it under Company.'),
    ).toBeVisible();
    await axe(page, 'a linked contact');

    // The second contact is linked through the search (names only, in a POST body).
    await visit(page, `/admin/contacts/${second}`);
    card = companyCard(page);
    await expect(card.getByText('Not linked to a company.')).toBeVisible();
    await card.getByRole('searchbox', { name: 'Link to a company' }).fill(`${RUN} typed`);
    await expect(card.getByRole('status')).toHaveText('1 company found.');
    await card.getByRole('button', { name: `Link ${typed}` }).click();
    await expect(card.locator('strong')).toHaveText(typed);

    const linked = await companyOf(page, companyId);
    expect(linked.company.contacts).toBe(2);
    expect(linked.contacts.map((c) => c.id).sort()).toEqual([first, second].sort());

    // A rename reaches both contacts' company name.
    const renamed = `E2E ${RUN} Renamed Co`;
    const res = await page.request.patch(`/api/admin/crm/companies/${companyId}`, {
      headers: { 'x-csrf-token': await csrf(page) },
      data: { version: linked.company.version, name: renamed },
    });
    expect(res.status()).toBe(200);
    await visit(page, `/admin/contacts/${first}`);
    card = companyCard(page);
    await expect(card.locator('strong')).toHaveText(renamed);

    // Unlink keeps the last name as free text, and the Details field is editable again.
    await card.getByRole('button', { name: 'Unlink' }).click();
    await expect(page.locator('#admin-toasts')).toContainText('Company unlinked.');
    await expect(card).toContainText(`Typed as ${renamed}, not linked to a company record yet.`);
    await expect(details).toHaveValue(renamed);
    await expect(details).toBeEditable();
    expect((await companyOf(page, companyId)).company.contacts).toBe(1);
  });

  test('arrival: inquiries naming one company share it, and its domain joins once a person edits it', async ({
    page,
  }) => {
    const domain = `e2e-${RUN}.example.invalid`;
    const arrival = `E2E ${RUN} Arrival Co`;
    // Named twice, folded alike (case and spaces): one company, made by the system, which
    // learns the inquiries' e-mail domain (not a consumer mailbox).
    await addLead(page, 'arrival one', `one-${RUN}@${domain}`, arrival);
    await addLead(page, 'arrival two', `two-${RUN}@${domain}`, `e2e ${RUN}  ARRIVAL co`);
    let found = await findCompanies(page, `${RUN} arrival`);
    expect(found.map((c) => [c.name, c.contacts, c.auto, c.domain])).toEqual([
      [arrival, 2, true, 'learnt'],
    ]);
    const company = found[0]!;
    // No company typed, the same domain: nobody has edited the company, so it collects no one.
    await addLead(page, 'arrival three', `three-${RUN}@${domain}`);
    found = await findCompanies(page, `${RUN} arrival`);
    expect(found.map((c) => c.contacts)).toEqual([2]);
    // A person edits it: from now on, that domain joins it.
    const edited = await page.request.patch(`/api/admin/crm/companies/${company.id}`, {
      headers: { 'x-csrf-token': await csrf(page) },
      data: { version: company.version, stage: 'client' },
    });
    expect(edited.status()).toBe(200);
    expect(((await edited.json()) as { data: Company }).data.domain).toBe('joins');
    await addLead(page, 'arrival four', `four-${RUN}@${domain}`);
    found = await findCompanies(page, `${RUN} arrival`);
    expect(found.map((c) => c.contacts)).toEqual([3]);

    // The drawer says a domain is held (never which), and the Admin forgets it.
    await visit(page, `/admin/contacts/companies?company=${company.id}`);
    const drawer = page.getByRole('dialog', { name: arrival });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('heading', { level: 3, name: 'E-mail domain' })).toBeVisible();
    await expect(drawer).toContainText(
      'This company learnt an e-mail domain from an inquiry. New inquiries from that domain that name no company join it.',
    );
    await expect(drawer).not.toContainText(domain);
    await axe(page, 'a company holding a learnt domain');
    await drawer.getByRole('button', { name: 'Forget the domain', exact: true }).click();
    await expect(
      drawer
        .getByRole('status')
        .filter({ hasText: 'Domain forgotten. Inquiries from it no longer join this company.' }),
    ).toBeVisible();
    await expect(drawer.getByRole('heading', { level: 3, name: 'E-mail domain' })).toHaveCount(0);
    expect((await companyOf(page, company.id)).company.domain).toBeNull();
    // That domain joins no one now.
    await addLead(page, 'arrival five', `five-${RUN}@${domain}`);
    found = await findCompanies(page, `${RUN} arrival`);
    expect(found.map((c) => [c.contacts, c.domain])).toEqual([[3, null]]);

    // The People list's sub-line counts companies.
    await visit(page, '/admin/contacts');
    await expect(page.locator('.admin-header .admin-sub')).toContainText(/ · \d+ compan(y|ies)$/);
  });
});

// Sales holds crm.contacts since C10b, so the Companies tab is its too (C11's departure
// "Sales"; the C10b + C11 integration, docs/admin-v2/as-built/C-LAST-INTEGRATION.md).
// Forgetting a learnt domain is crm.settings', which Sales does not hold.
test.describe('as sales', () => {
  test.use({ storageState: authFile('sales') });

  test('the Companies tab opens, a company is added and found; forgetting a domain is refused', async ({
    page,
  }) => {
    const res = await visit(page, '/admin/contacts/companies');
    expect(res?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: 'Companies' })).toBeVisible();
    const company = await addCompany(page, `E2E ${RUN} sales co`);
    expect((await findCompanies(page, `${RUN} sales co`)).map((c) => c.id)).toEqual([company.id]);
    expect((await companyOf(page, company.id)).company.name).toBe(company.name);
    const forget = await page.request.delete(`/api/admin/crm/companies/${company.id}/domain`, {
      headers: { 'x-csrf-token': await csrf(page) },
      data: { version: company.version },
    });
    expect(forget.status()).toBe(403);
  });
});

for (const role of ['content_creator', 'seo', 'developer'] as const) {
  test.describe(`as ${role}`, () => {
    test.use({ storageState: authFile(role) });

    // A real company, added as the Admin, for the refused role to try to open.
    let company: Company;
    test.beforeAll(async ({ browser }) => {
      const context = await browser.newContext({ storageState: authFile('admin') });
      const page = await context.newPage();
      company = await addCompany(page, `Refused Co ${randomBytes(4).toString('hex')}`);
      await context.close();
    });

    test('the Companies tab and its API are refused by the server, naming no company', async ({
      page,
    }) => {
      for (const path of [
        '/admin/contacts/companies',
        `/admin/contacts/companies?company=${company.id}`,
      ]) {
        const res = await visit(page, path);
        expect(res?.status(), path).toBe(403);
        await expect(page.locator('main .msg[data-kind="error"]').first()).toContainText(
          'Your role does not allow that.',
        );
        expect(await page.content(), path).not.toContain(company.name);
      }
      const asks = [
        ['post', '/api/admin/crm/companies/query', {}],
        ['post', '/api/admin/crm/companies', { name: `E2E ${RUN} refused` }],
        ['get', `/api/admin/crm/companies/${company.id}`, null],
        ['patch', `/api/admin/crm/companies/${company.id}`, { version: 1, city: 'Riyadh' }],
        ['delete', `/api/admin/crm/companies/${company.id}`, { version: 1 }],
        ['delete', `/api/admin/crm/companies/${company.id}/domain`, { version: 1 }],
      ] as const;
      for (const [method, api, data] of asks) {
        const headers = { 'x-csrf-token': await csrf(page) };
        const res =
          method === 'get'
            ? await page.request.get(api)
            : await page.request[method](api, { headers, data: data ?? {} });
        expect(res.status(), `${method} ${api}`).toBe(403);
        expect(await res.text(), api).not.toContain(company.name);
      }
    });
  });
}
