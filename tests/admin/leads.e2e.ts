import AxeBuilder from '@axe-core/playwright';
import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { SKIP_REASON, authFile, staffEnv } from './staff';

/*
 * The leads screens, end to end (Admin v2 C4b, crm.md §11 and §13), on the real Worker and the
 * local stack, as the Admin (and, for the refusals, as Content Creator and SEO):
 *   round trip  a real POST /api/contact with no session lands in the list within seconds,
 *               carrying no contact detail, and the sidebar's Leads badge goes up;
 *   the list    a filter writes the address and never the search; a whole e-mail finds its
 *               lead through the blind index and stays out of the address; the star; a bulk
 *               move; a stale version in a second tab gives the conflict words;
 *   a lead      Previous and Next in the list's filter; the reveal shows the values and
 *               writes one audit row; a note; a logged call; a stage move, then a conflict
 *               from another tab; an Admin's erase (a 404 after);
 *   the drawer  add by hand onto the lead's page; a phone-only duplicate asks, "Add as
 *               someone new" adds; focus returns to the button;
 *   refusals    Content Creator and SEO get a 403 page (and API) on both paths, with no
 *               lead's name in the HTML.
 * axe runs with each dialog and the move menu open. Every lead it adds is named with this
 * run's token and added through the real routes; nothing reads or writes the database
 * directly.
 */

test.skip(!staffEnv(), SKIP_REASON);
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const RUN = randomBytes(4).toString('hex');
const PII_KEYS = [
  'email',
  'phone',
  'budget',
  'timeline',
  'notes',
  'internal_notes',
  'email_hmac',
  'phone_hmac',
  'score_signals',
  'tags',
];

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

interface Added {
  id: string;
  name: string;
  email?: string;
  phone?: string;
}

/** A lead added by hand through the real route, as the signed-in person. */
async function addLead(
  page: Page,
  label: string,
  extra: { email?: string; phone?: string; channel?: string } = {},
): Promise<Added> {
  const name = `E2E ${RUN} ${label}`;
  const body = {
    name,
    message: `A test inquiry (${label}).`,
    channel: extra.channel ?? 'phone',
    ...(extra.email || !extra.phone
      ? { email: extra.email ?? `${label}-${RUN}@example.invalid` }
      : {}),
    ...(extra.phone ? { phone: extra.phone } : {}),
  };
  const res = await page.request.post('/api/admin/leads', {
    headers: { 'x-csrf-token': await csrf(page) },
    data: body,
  });
  expect(res.status(), `add ${label}`).toBe(200);
  const { data } = (await res.json()) as { data: { id: string } };
  return {
    id: data.id,
    name,
    ...('email' in body ? { email: body.email as string } : {}),
    ...extra,
  };
}

async function query(page: Page, body: Record<string, unknown>) {
  const res = await page.request.post('/api/admin/leads/query', {
    headers: { 'x-csrf-token': await csrf(page) },
    data: body,
  });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { data: { rows: Record<string, unknown>[]; total: number } }).data;
}

async function stages(request: APIRequestContext) {
  const res = await request.get('/api/admin/crm/stages');
  expect(res.status()).toBe(200);
  return ((await res.json()) as { data: { stages: { id: string; label: string; key: string }[] } })
    .data.stages;
}

async function leadOf(page: Page, id: string) {
  const res = await page.request.get(`/api/admin/leads/${id}`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

/** A versioned stage change through the API: what a colleague in another tab does. */
async function moveBehindTheScreen(page: Page, id: string, stageId: string) {
  const lead = await leadOf(page, id);
  const res = await page.request.patch(`/api/admin/leads/${id}`, {
    headers: { 'x-csrf-token': await csrf(page) },
    data: { version: lead['version'], stageId },
  });
  expect(res.status()).toBe(200);
}

test.describe('as admin', () => {
  test.use({ storageState: authFile('admin') });

  test('round trip: a contact form lead lands in the list, with no contact detail', async ({
    page,
    browser,
  }) => {
    await page.goto('/admin/leads');
    const badge = page.locator('nav.admin-sidebar a[href="/admin/leads"] .cnt');
    const before = (await badge.count())
      ? Number.parseInt((await badge.innerText()) || '0', 10)
      : 0;

    const visitor = await browser.newContext();
    const base = new URL(page.url()).origin;
    const name = `E2E round trip ${RUN}`;
    const posted = await visitor.request.post('/api/contact', {
      headers: { origin: base },
      data: {
        name,
        email: `round-trip-${RUN}@example.invalid`,
        message: 'A real inquiry from the contact form, sent by the e2e run.',
        consentMarketing: true,
      },
    });
    expect(posted.status(), 'the public form takes the inquiry').toBeLessThan(300);
    await visitor.close();

    await expect
      .poll(async () => (await query(page, { q: name, limit: 5 })).rows.length, { timeout: 5000 })
      .toBe(1);
    const [row] = (await query(page, { q: name, limit: 5 })).rows;
    for (const key of PII_KEYS) expect(row, key).not.toHaveProperty(key);
    expect(row!['source']).toBe('web_form');

    await page.reload();
    // Up by this lead at least (another spec may add leads meanwhile).
    await expect
      .poll(async () => Number.parseInt((await badge.innerText()) || '0', 10))
      .toBeGreaterThan(before);
  });

  test('the list: filters in the address, never the search; the star; a bulk move', async ({
    page,
  }) => {
    const one = await addLead(page, 'bulk-a');
    const two = await addLead(page, 'bulk-b');
    await page.goto('/admin/leads');
    await page.getByLabel('Range').selectOption('30');
    await expect(page).toHaveURL(/[?&]range=30/);

    // A whole e-mail finds its lead (the blind index) and never reaches the address.
    const search = page.getByRole('searchbox', { name: 'Search leads' });
    await search.fill(one.email!);
    await search.press('Enter');
    await expect(page.getByRole('link', { name: one.name })).toBeVisible();
    expect(page.url()).not.toContain('q=');
    expect(decodeURIComponent(page.url())).not.toContain(one.email!);

    // The star: pressed, and kept.
    const star = page.getByRole('button', { name: `Star ${one.name}` });
    await star.click();
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await leadOf(page, one.id))['is_starred']).toBe(true);

    // Two leads ticked and moved together.
    // Both names hold this run's token and "bulk": one search finds the two, nothing else.
    await search.fill(`${RUN} bulk`);
    await search.press('Enter');
    await page.getByRole('checkbox', { name: `Select ${one.name}` }).check();
    await page.getByRole('checkbox', { name: `Select ${two.name}` }).check();
    const bar = page.getByRole('region', { name: 'Bulk actions' });
    await bar
      .getByLabel('Move the selected leads to the stage')
      .selectOption({ label: 'Contacted' });
    await bar.getByRole('button', { name: 'Move' }).click();
    await expect(page.locator('#admin-toasts')).toContainText('Done. 2 leads changed.');
    await axe(page, 'the leads list');
  });

  test('the list: a lead a colleague changed meanwhile is a conflict, said and refreshed', async ({
    page,
  }) => {
    const lead = await addLead(page, 'stale');
    const all = await stages(page.request);
    await page.goto('/admin/leads');
    const search = page.getByRole('searchbox', { name: 'Search leads' });
    await search.fill(lead.name);
    await search.press('Enter');
    await page.getByRole('checkbox', { name: `Select ${lead.name}` }).check();
    // Another tab moves it first: the version this page read is stale now.
    await moveBehindTheScreen(page, lead.id, all.find((s) => s.key === 'contacted')!.id);
    const bar = page.getByRole('region', { name: 'Bulk actions' });
    await bar
      .getByLabel('Move the selected leads to the stage')
      .selectOption({ label: 'Proposal sent' });
    await bar.getByRole('button', { name: 'Move' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'changed by someone else' }),
    ).toContainText('1 lead was changed by someone else. Refreshed.');
  });

  for (const width of [320, 390]) {
    test(`the list and a lead's page at ${width} px do not overflow`, async ({ page }) => {
      const lead = await addLead(page, `narrow-${width}`);
      await page.setViewportSize({ width, height: 800 });
      for (const path of ['/admin/leads', `/admin/leads/${lead.id}`]) {
        await page.goto(path, { waitUntil: 'networkidle' });
        const over = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(over, path).toBeLessThanOrEqual(2);
      }
    });
  }

  test('a lead: Previous and Next in the list’s filter', async ({ page }) => {
    // Three leads only this test adds by "event", so the filter holds them and nothing else
    // another test adds meanwhile.
    for (const n of [1, 2, 3]) await addLead(page, `step-${n}`, { channel: 'event' });
    const filter = { source: 'manual', channel: 'event', sort: 'starred' };
    const rows = (await query(page, { ...filter, limit: 100 })).rows.map((r) => String(r['id']));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const middle = rows[1]!;
    await page.goto(`/admin/leads/${middle}?source=manual&channel=event`);
    await expect(page.getByRole('link', { name: /^Previous/ })).toHaveAttribute(
      'href',
      `/admin/leads/${rows[0]}?source=manual&channel=event`,
    );
    await expect(page.getByRole('link', { name: /^Next/ })).toHaveAttribute(
      'href',
      `/admin/leads/${rows[2]}?source=manual&channel=event`,
    );
    await expect(page.getByRole('link', { name: /^Back/ })).toHaveAttribute(
      'href',
      '/admin/leads?source=manual&channel=event',
    );
    // The tab never carries the person's name; the h1 does.
    await expect(page).toHaveTitle(/^Lead · /);
  });

  test('a lead: the reveal, a note, a logged call, a stage move and a conflict', async ({
    page,
  }) => {
    const lead = await addLead(page, 'detail', { email: `detail-${RUN}@example.invalid` });
    await page.goto(`/admin/leads/${lead.id}`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 1, name: lead.name })).toBeVisible();
    expect(await page.content()).not.toContain(lead.email!);

    await page
      .getByRole('button', { name: 'Reveal contact details (this access is logged)' })
      .click();
    await expect(page.getByText(lead.email!, { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Email', exact: true })).toHaveAttribute(
      'href',
      `mailto:${lead.email}`,
    );
    const audit = await page.request.get(`/api/admin/audit?entityType=lead&entityId=${lead.id}`);
    expect(audit.status()).toBe(200);
    const entries = ((await audit.json()) as { data: { rows: { verb: string }[] } }).data.rows;
    expect(entries.filter((e) => e.verb === 'Revealed the contact details of')).toHaveLength(1);

    // A note: in the thread, and in the timeline.
    await page.getByLabel('New note').fill(`Called back (${RUN})`);
    await page.getByRole('button', { name: 'Add note' }).click();
    await expect(page.getByText(`Called back (${RUN})`)).toBeVisible();
    await expect(page.locator('.tl__t', { hasText: 'Note added' })).toBeVisible();

    // A logged call.
    await page.getByLabel('Log contact').selectOption('call');
    await page.getByRole('button', { name: 'Log', exact: true }).click();
    await expect(page.locator('.tl__t', { hasText: 'Call logged' })).toBeVisible();

    // The stage, through Move to…
    await page.getByRole('button', { name: `Move to… ${lead.name}` }).click();
    await page.locator('.moveto__m').getByRole('button', { name: 'Contacted' }).click();
    await expect(page.getByText('Moved to Contacted.')).toBeVisible();

    // Another tab moves it again: this page's version is stale, and it says so.
    const all = await stages(page.request);
    await moveBehindTheScreen(page, lead.id, all.find((s) => s.key === 'proposal')!.id);
    await page.getByRole('button', { name: `Move to… ${lead.name}` }).click();
    await page.locator('.moveto__m button').first().click();
    await expect(page.getByText('Someone else changed this. Refreshed.')).toBeVisible();
    await axe(page, 'a lead with its details revealed');
  });

  test('a lead: an Admin erases it, and it is gone', async ({ page }) => {
    const lead = await addLead(page, 'erase');
    await page.goto(`/admin/leads/${lead.id}`, { waitUntil: 'networkidle' });
    await page.getByText('More actions').click();
    await page.getByRole('button', { name: 'Erase this lead…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Erase this lead' });
    await expect(dialog).toBeVisible();
    await axe(page, 'the erase dialog');
    await dialog.getByLabel('Our decision').check();
    await dialog.getByRole('button', { name: 'Erase the lead' }).click();
    await page.waitForURL((url) => url.pathname === '/admin/leads');
    const gone = await page.request.get(`/admin/leads/${lead.id}`);
    expect(gone.status()).toBe(404);
  });

  test('the drawer: a lead added by hand, and a phone that wrote before', async ({ page }) => {
    const phone = `+9665${String(Date.now()).slice(-8)}`;
    await addLead(page, 'first-phone', { phone });
    await page.goto('/admin/leads');
    const open = page.getByRole('button', { name: 'Add lead manually' });
    await expect(open).toBeVisible();
    await open.click();
    const drawer = page.getByRole('dialog', { name: 'Add a lead manually' });
    await expect(drawer).toBeVisible();
    await axe(page, 'the add drawer');
    // Cancel returns focus to the button.
    await drawer.getByRole('button', { name: 'Cancel' }).click();
    await expect(open).toBeFocused();

    await open.click();
    await drawer.getByLabel(/^Name/).fill(`E2E second-phone ${RUN}`);
    await drawer.getByLabel('Phone or WhatsApp').fill(phone);
    await drawer.getByLabel(/^Message/).fill('A second call from the same number.');
    await drawer.getByRole('button', { name: 'Add lead', exact: true }).click();
    await expect(drawer.getByText('This phone number is on an earlier lead.')).toBeVisible();
    await drawer.getByRole('button', { name: 'Add as someone new' }).click();
    await page.waitForURL(/\/admin\/leads\/[0-9a-f-]{36}$/);
    await expect(
      page.getByRole('heading', { level: 1, name: `E2E second-phone ${RUN}` }),
    ).toBeVisible();
  });
});

for (const role of ['content_creator', 'seo'] as const) {
  test.describe(`as ${role}`, () => {
    test.use({ storageState: authFile(role) });

    test('every leads page is refused by the server, naming no lead', async ({ page }) => {
      const probe = '00000000-0000-4000-8000-000000000000';
      for (const path of ['/admin/leads', `/admin/leads/${probe}`]) {
        const res = await page.goto(path);
        expect(res?.status(), path).toBe(403);
        await expect(page.locator('main .msg[data-kind="error"]').first()).toContainText(
          'Your role does not allow that.',
        );
        expect(await page.content(), path).not.toContain(`E2E `);
      }
      for (const [method, api] of [
        ['post', '/api/admin/leads/query'],
        ['post', '/api/admin/leads/board'],
        ['get', `/api/admin/leads/${probe}`],
      ] as const) {
        const res =
          method === 'post'
            ? await page.request.post(api, {
                headers: { 'x-csrf-token': await csrf(page) },
                data: {},
              })
            : await page.request.get(api);
        expect(res.status(), api).toBe(403);
      }
    });
  });
}
