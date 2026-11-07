import { randomBytes } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { TENANT_ID } from '../../scripts/gen-seeds.mjs';
import { expectCleanAtWidths } from './collectionLayout';
import {
  discardDrafts,
  discardDraftsLike,
  publishOwn,
  reorderedIds,
  systemClient,
  tryPublishOwn,
} from './releaseSteps';
import { SKIP_REASON, authFile, releasesOn, staffEnv } from './staff';

/*
 * The five collections on the AdminCollection island (Admin v2 U7b), signed in as
 * content_creator, against this job's local Supabase:
 *
 *   the sample quote  a design sample's words are read-only in the drawer and it has no
 *                     Duplicate; "Make this quote real" opens them; scheduling it without
 *                     consent is refused on the consent field; with consent, ONE save stores
 *                     the new words, the consent and the cleared flag (the 0028 sample lock's
 *                     only accepted path), and the row loses its Sample badge;
 *   a client          hidden until cleared ("Not cleared to name"); Duplicate makes a hidden
 *                     copy with its own slug, right after it; "Visible on the site" clears
 *                     it in one save;
 *   numbers           a keyboard move (handle, Space, ArrowUp, Space) reorders them, and the
 *                     seed's archived numbers (an Admin's rows only) keep their places;
 *   team              offers no Duplicate (people are not copied by accident);
 *   every width       each screen's list and add drawer, a client's edit drawer and the sample
 *                     quote's drawer with zero axe WCAG 2.2 A/AA violations and no sideways
 *                     scroll at 320, 390 and 1280 px.
 *
 * The rows are this run's own (a random marker in the slug), made by the service role and
 * removed by it afterwards, and none of them reaches a public page: the quote is scheduled
 * for 2099 with no placement, the client stays out of the marquee, the numbers are drafts.
 * The public suites pin the seeded rows (eight marquee names, three quotes on Home), so this
 * suite never publishes beside them; what `visible` and a published quote do on the site is
 * tests/e2e/home-sections.e2e.ts's and pgTAP's.
 *
 * Both modes (Admin v2 R14d). With releases on every save is a pending change and live moves
 * only when this run publishes its own (`publishOwn`): the sample quote's one save is staged
 * (an item is never scheduled on its own, so it is "Visible on the site"), its publish is
 * refused for want of consent (release mode checks consent when a change goes live), and with
 * consent recorded and the quote kept off the site (not visible) the publish makes it real in
 * one change; the client's copy is a pending create and its clearing goes live when published;
 * the numbers' move is published by the ids its reorder named. Nothing here leaves the end of
 * each list (sort order 9980 and up), so the first rows other specs open are never staged. The
 * clean-up throws this run's unclaimed pending changes away as the system before the rows go.
 */

test.skip(!staffEnv(), SKIP_REASON);
test.use({
  contextOptions: { reducedMotion: 'reduce' },
  storageState: authFile('content_creator'),
});
test.describe.configure({ mode: 'serial' });

const MARK = randomBytes(4).toString('hex');
const slug = (kind: string) => `e2e-${kind}-${MARK}`;

const service = systemClient;
const TABLES = [
  ['testimonials', 'testimonial'],
  ['clients', 'client'],
  ['statistics', 'statistic'],
] as const;
/** Rows a move of this run named that are not its own, for the clean-up. */
const touched = new Set<string>();

const SAMPLE_WORDS = { en: `Sample words ${MARK}.`, ar: `كلمات العينة ${MARK}.` };
const AUTHOR = { en: `Sample Person ${MARK}`, ar: `شخص العينة ${MARK}` };
const CLIENT = { en: `Client ${MARK}`, ar: `عميل ${MARK}` };
const NUMBER = (n: number) => ({ en: `Number ${n} ${MARK}`, ar: `رقم ${n} ${MARK}` });

test.beforeAll(async () => {
  if (!staffEnv()) return;
  const svc = service();
  const inserts = [
    svc.from('testimonials').insert({
      tenant_id: TENANT_ID,
      slug: slug('sample'),
      quote: SAMPLE_WORDS,
      author_name: AUTHOR,
      is_placeholder: true,
      status: 'draft',
      sort_order: 9990,
    }),
    svc.from('clients').insert({
      tenant_id: TENANT_ID,
      slug: slug('client'),
      name: CLIENT,
      visible: false,
      show_in_marquee: false,
      sort_order: 9990,
    }),
    svc.from('statistics').insert([
      {
        tenant_id: TENANT_ID,
        slug: slug('n1'),
        label: NUMBER(1),
        value: '1',
        status: 'draft',
        sort_order: 9980,
      },
      {
        tenant_id: TENANT_ID,
        slug: slug('n2'),
        label: NUMBER(2),
        value: '2',
        status: 'draft',
        sort_order: 9990,
      },
    ]),
  ];
  for (const { error } of await Promise.all(inserts)) expect(error).toBeNull();
});

test.afterAll(async () => {
  if (!staffEnv()) return;
  const svc = service();
  // Releases on: this run's unclaimed pending changes first (creates by their slug, edits by
  // the rows' ids), as the system.
  for (const [table, entityType] of TABLES) {
    await discardDraftsLike(entityType, 'payload->>slug', `e2e-%-${MARK}%`);
    const { data } = await svc.from(table).select('id').like('slug', `e2e-%-${MARK}%`);
    const ids = (data ?? []).map((r) => String(r.id));
    await discardDrafts([{ entityType, entityIds: [...ids, ...touched] }]);
  }
  for (const [table] of TABLES) {
    await svc.from(table).delete().like('slug', `e2e-%-${MARK}%`);
  }
});

async function openScreen(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  await expect(page.locator('ul.coll__list')).toBeVisible();
}

/** A list row's action: focus, then Enter (hover arms a pointer press only after 0.2s). */
async function pressRowAction(button: Locator): Promise<void> {
  await button.focus();
  await button.press('Enter');
}

const row = (page: Page, text: string) => page.locator('ul.coll__list > li', { hasText: text });
const dialog = (page: Page) => page.getByRole('dialog');
/**
 * A row's badges, each by its whole word. Never the row's text: the sample's author is
 * "Sample Person …", so "Sample" is in its title whether or not the badge is.
 */
const badges = (rowLocator: Locator) => rowLocator.locator('.badge');

async function serviceRow(table: string, key: string) {
  const { data, error } = await service().from(table).select('*').eq('slug', key).single();
  expect(error).toBeNull();
  return data as Record<string, unknown>;
}

/**
 * A row as the screen's own list reads it (releases on: live with the pending changes laid
 * over it, so a pending create is there too), found by its slug.
 */
async function listed(page: Page, api: string, key: string) {
  const res = await page.request.get(`${api}?limit=100`);
  expect(res.status(), api).toBe(200);
  const rows = ((await res.json()) as { data: { rows: Record<string, unknown>[] } }).data.rows;
  const found = rows.find((r) => r['slug'] === key);
  expect(found, `${api} lists ${key}`).toBeTruthy();
  return found!;
}

test('a sample quote is made real in one save, consent first', async ({ page }) => {
  await openScreen(page, '/admin/testimonials');
  const sample = row(page, AUTHOR.en);
  await expect(badges(sample)).toHaveText(['Sample', 'Draft']);
  // A sample is never copied (the lock refuses creating one; its words are nobody's).
  await sample.hover();
  await expect(
    page.getByRole('button', { name: new RegExp(`^Duplicate ${AUTHOR.en}`) }),
  ).toHaveCount(0);

  await sample.locator('a.li__t').click();
  const drawer = dialog(page);
  await expect(drawer.getByRole('heading', { name: 'Edit quote' })).toBeVisible();
  await expect(drawer).toContainText('This is a design sample.');
  // The words are shown, not editable, until the switch is on.
  await expect(drawer.getByRole('figure', { name: "The sample's words" })).toContainText(
    SAMPLE_WORDS.en,
  );
  await expect(drawer.locator('#f-quote-en')).toHaveCount(0);
  await expectCleanAtWidths(page, 'the sample quote drawer');

  await drawer.getByRole('switch', { name: 'Make this quote real' }).click();
  await drawer
    .getByRole('group', { name: 'Editing language' })
    .getByRole('radio', { name: 'Both' })
    .check();
  const real = { en: `Real words ${MARK}.`, ar: `كلمات حقيقية ${MARK}.` };
  await drawer.locator('#f-quote-en').fill(real.en);
  await drawer.locator('#f-quote-ar').fill(real.ar);
  // The sample's own row: its id names its pending change with releases on.
  const sampleId = String((await serviceRow('testimonials', slug('sample')))['id']);
  const own = [{ entityType: 'testimonial', entityIds: [sampleId] }];

  if (!releasesOn()) {
    await drawer.locator('#f-status').selectOption('scheduled');
    await drawer.locator('#f-scheduledFor').fill('2099-01-01T09:00');
    await drawer.getByRole('button', { name: 'Save changes', exact: true }).click();
    // No consent recorded: refused, on the consent field, and nothing stored.
    // The refusal's own words (the field's hint also says "agreed to be quoted"): the
    // Worker's assertPublishable, or the CHECK's mapped message.
    await expect(
      drawer.getByText(/record when (the person agreed|consent was obtained)/i).first(),
    ).toBeVisible();
    expect((await serviceRow('testimonials', slug('sample')))['is_placeholder']).toBe(true);

    await drawer.locator('#f-consentObtainedAt').fill('2026-10-01T10:00');
    await drawer.locator('#f-consentReference').fill(`email ${MARK}`);
    await drawer.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
  } else {
    // An item is never scheduled on its own: the status is "Visible on the site". The save is
    // a pending change (the drawer stayed open while the fields above saved on leaving them),
    // and live is still the sample.
    await expect(drawer.locator('#f-scheduledFor')).toHaveCount(0);
    const visible = drawer.getByRole('switch', { name: 'Visible on the site' });
    await visible.click();
    await expect(visible).toHaveAttribute('aria-checked', 'true');
    await drawer.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect((await serviceRow('testimonials', slug('sample')))['is_placeholder']).toBe(true);
    // No consent recorded: the publish is refused, naming consent, and live keeps the sample.
    const refused = await tryPublishOwn(page, own);
    expect(refused!.status, refused!.text).toBe(422);
    expect(refused!.text).toMatch(/record when (the person agreed|consent was obtained)/i);
    expect((await serviceRow('testimonials', slug('sample')))['is_placeholder']).toBe(true);

    // Consent recorded, and the quote kept off the site (no visible: it has no placement, and
    // a quote with none may still be listed where a section names no placement).
    await openScreen(page, '/admin/testimonials');
    await row(page, AUTHOR.en).locator('a.li__t').click();
    await expect(dialog(page).getByRole('heading', { name: 'Edit quote' })).toBeVisible();
    await expect(dialog(page).locator('#f-quote-en')).toHaveValue(real.en);
    await dialog(page).locator('#f-consentObtainedAt').fill('2026-10-01T10:00');
    await dialog(page).locator('#f-consentReference').fill(`email ${MARK}`);
    const shown = dialog(page).getByRole('switch', { name: 'Visible on the site' });
    await shown.click();
    await expect(shown).toHaveAttribute('aria-checked', 'false');
    await dialog(page).getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    // The one change that makes it real: the words, the consent and the cleared flag at once.
    await publishOwn(page, own);
    await openScreen(page, '/admin/testimonials');
  }

  const stored = await serviceRow('testimonials', slug('sample'));
  expect(stored['is_placeholder']).toBe(false);
  expect(stored['quote']).toEqual(real);
  expect(stored['consent_obtained_at']).toBeTruthy();
  expect(stored['consent_reference']).toBe(`email ${MARK}`);
  expect(stored['status']).toBe(releasesOn() ? 'draft' : 'scheduled');
  // Its badges: the status only (no Sample, and no Needs consent: consent is recorded).
  await expect(badges(row(page, AUTHOR.en))).toHaveText([releasesOn() ? 'Draft' : 'Scheduled']);
});

test('a client: hidden until cleared, copied hidden, cleared with one switch', async ({ page }) => {
  await openScreen(page, '/admin/clients');
  const client = row(page, CLIENT.en).first();
  await expect(client).toContainText('Not cleared to name');

  await pressRowAction(client.getByRole('button', { name: `Duplicate ${CLIENT.en}` }));
  await expect(page.locator('.toast', { hasText: 'Copied as a draft.' }).first()).toBeVisible();
  await expect(row(page, CLIENT.en)).toHaveCount(2);
  // Releases on the copy is a pending create: the screen's own list has it.
  const copy = releasesOn()
    ? await listed(page, '/api/admin/clients', `${slug('client')}-copy`)
    : await serviceRow('clients', `${slug('client')}-copy`);
  expect(copy['visible']).toBe(false);
  // (A pending create carries only what it writes: no flag is no sample.)
  expect(copy['is_placeholder'] ?? false).toBe(false);
  const texts = await page.locator('ul.coll__list > li').allTextContents();
  const at = texts.findIndex((t) => t.includes(CLIENT.en));
  expect(texts[at + 1]).toContain(CLIENT.en);

  await row(page, CLIENT.en).first().locator('a.li__t').click();
  const drawer = dialog(page);
  await expect(drawer.getByRole('heading', { name: 'Edit client' })).toBeVisible();
  await expectCleanAtWidths(page, 'the client drawer');
  const visible = drawer.getByRole('switch', { name: 'Visible on the site' });
  await expect(visible).toHaveAttribute('aria-checked', 'false');
  await visible.click();
  await drawer.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(row(page, CLIENT.en).first()).not.toContainText('Not cleared to name');
  // Releases on: the clearing goes live with this run's own publish (the client alone; its
  // pending copy stays unpublished and is thrown away by the clean-up).
  const clientId = String((await serviceRow('clients', slug('client')))['id']);
  await publishOwn(page, [{ entityType: 'client', entityIds: [clientId] }]);
  expect((await serviceRow('clients', slug('client')))['visible']).toBe(true);
});

/** The seed's archived legacy numbers (30-legacy-demo.json), slug to `sort_order`. */
async function archivedNumbers(): Promise<Record<string, unknown>> {
  const { data, error } = await service()
    .from('statistics')
    .select('slug, sort_order')
    .eq('tenant_id', TENANT_ID)
    .in('slug', ['projects', 'services', 'years']);
  expect(error).toBeNull();
  return Object.fromEntries((data ?? []).map((r) => [String(r.slug), r.sort_order]));
}

test('numbers: a keyboard move reorders them', async ({ page }) => {
  await openScreen(page, '/admin/statistics');
  const second = NUMBER(2).en;
  const texts = await page.locator('ul.coll__list > li').allTextContents();
  expect(texts.findIndex((t) => t.includes(second))).toBe(
    texts.findIndex((t) => t.includes(NUMBER(1).en)) + 1,
  );
  // The seed's archived numbers are listed: a Content Creator may not write those rows (0018).
  await expect(
    page.locator('ul.coll__list > li .badge').filter({ hasText: /^Archived$/ }),
  ).not.toHaveCount(0);
  const archivedBefore = await archivedNumbers();
  expect(Object.keys(archivedBefore).sort()).toEqual(['projects', 'services', 'years']);

  // The reorder's address carries ?staged=1 with releases on: matched by its path.
  const reorder = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === '/api/admin/statistics/reorder' &&
      res.request().method() === 'POST',
  );
  await page.getByRole('button', { name: new RegExp(`^Reorder .*${second}`) }).focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  const response = await reorder;
  expect(response.status(), await response.text()).toBe(200);
  await expect(page.locator('.toast', { hasText: 'Order updated.' }).first()).toBeVisible();
  // Releases on: exactly the rows the move named go live (this run's two numbers).
  const moved = reorderedIds(response.request().postData());
  const ownIds = await Promise.all(
    [slug('n1'), slug('n2')].map(async (key) =>
      String((await serviceRow('statistics', key))['id']),
    ),
  );
  for (const id of moved) if (!ownIds.includes(id)) touched.add(id);
  await publishOwn(page, [{ entityType: 'statistic', entityIds: moved }]);

  const one = Number((await serviceRow('statistics', slug('n1')))['sort_order']);
  const two = Number((await serviceRow('statistics', slug('n2')))['sort_order']);
  expect(two).toBeLessThan(one);
  // The move left the archived rows as they were.
  expect(await archivedNumbers()).toEqual(archivedBefore);
});

test('team members are never duplicated', async ({ page }) => {
  await openScreen(page, '/admin/team');
  await expect(page.locator('ul.coll__list > li').first()).toBeVisible();
  await page.locator('ul.coll__list > li').first().hover();
  await expect(page.getByRole('button', { name: /^Duplicate / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Edit / }).first()).toBeVisible();
});

for (const [path, heading] of [
  ['/admin/testimonials', 'New quote'],
  ['/admin/clients', 'New client'],
  ['/admin/team', 'New team member'],
  ['/admin/statistics', 'New number'],
  ['/admin/certifications', 'New certification'],
] as const) {
  test(`${path}: the list and the add drawer at 320, 390 and 1280 px`, async ({ page }) => {
    await openScreen(page, path);
    await expectCleanAtWidths(page, `${path} list`);
    await page.locator('a[data-collection-add]').click();
    await expect(dialog(page).getByRole('heading', { name: heading })).toBeVisible();
    await expectCleanAtWidths(page, `${path} add drawer`);
  });
}
