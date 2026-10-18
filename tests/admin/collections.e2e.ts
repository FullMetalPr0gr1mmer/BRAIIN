import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { TENANT_ID } from '../../scripts/gen-seeds.mjs';
import { SKIP_REASON, authFile, staffEnv } from './staff';

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
 *   numbers           a keyboard move (handle, Space, ArrowUp, Space) reorders them;
 *   team              offers no Duplicate (people are not copied by accident).
 *
 * The rows are this run's own (a random marker in the slug), made by the service role and
 * removed by it afterwards, and none of them reaches a public page: the quote is scheduled
 * for 2099 with no placement, the client stays out of the marquee, the numbers are drafts.
 * The public suites pin the seeded rows (eight marquee names, three quotes on Home), so this
 * suite never publishes beside them; what `visible` and a published quote do on the site is
 * tests/e2e/home-sections.e2e.ts's and pgTAP's.
 */

test.skip(!staffEnv(), SKIP_REASON);
test.use({
  contextOptions: { reducedMotion: 'reduce' },
  storageState: authFile('content_creator'),
});
test.describe.configure({ mode: 'serial' });

const MARK = randomBytes(4).toString('hex');
const slug = (kind: string) => `e2e-${kind}-${MARK}`;

function service() {
  const env = staffEnv()!;
  return createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

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
  for (const table of ['testimonials', 'clients', 'statistics']) {
    await svc.from(table).delete().like('slug', `e2e-%-${MARK}%`);
  }
});

async function openScreen(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  await expect(page.locator('ul.coll__list')).toBeVisible();
}

const row = (page: Page, text: string) => page.locator('ul.coll__list > li', { hasText: text });
const dialog = (page: Page) => page.getByRole('dialog');

async function serviceRow(table: string, key: string) {
  const { data, error } = await service().from(table).select('*').eq('slug', key).single();
  expect(error).toBeNull();
  return data as Record<string, unknown>;
}

test('a sample quote is made real in one save, consent first', async ({ page }) => {
  await openScreen(page, '/admin/testimonials');
  const sample = row(page, AUTHOR.en);
  await expect(sample).toContainText('Sample');
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
  await expect(drawer.getByRole('figure', { name: 'The sample’s words' })).toContainText(
    SAMPLE_WORDS.en,
  );
  await expect(drawer.locator('#f-quote-en')).toHaveCount(0);

  await drawer.getByRole('switch', { name: 'Make this quote real' }).click();
  await drawer
    .getByRole('group', { name: 'Editing language' })
    .getByRole('radio', { name: 'Both' })
    .check();
  const real = { en: `Real words ${MARK}.`, ar: `كلمات حقيقية ${MARK}.` };
  await drawer.locator('#f-quote-en').fill(real.en);
  await drawer.locator('#f-quote-ar').fill(real.ar);
  await drawer.locator('#f-status').selectOption('scheduled');
  await drawer.locator('#f-scheduledFor').fill('2099-01-01T09:00');
  await drawer.getByRole('button', { name: 'Save changes', exact: true }).click();
  // No consent recorded: refused, on the consent field, and nothing stored.
  await expect(drawer.getByText(/agreed to be quoted|consent was obtained/i).first()).toBeVisible();
  expect((await serviceRow('testimonials', slug('sample')))['is_placeholder']).toBe(true);

  await drawer.locator('#f-consentObtainedAt').fill('2026-10-01T10:00');
  await drawer.locator('#f-consentReference').fill(`email ${MARK}`);
  await drawer.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);

  const stored = await serviceRow('testimonials', slug('sample'));
  expect(stored['is_placeholder']).toBe(false);
  expect(stored['quote']).toEqual(real);
  expect(stored['consent_obtained_at']).toBeTruthy();
  expect(stored['consent_reference']).toBe(`email ${MARK}`);
  expect(stored['status']).toBe('scheduled');
  await expect(row(page, AUTHOR.en)).not.toContainText('Sample');
  await expect(row(page, AUTHOR.en)).not.toContainText('Needs consent');
});

test('a client: hidden until cleared, copied hidden, cleared with one switch', async ({ page }) => {
  await openScreen(page, '/admin/clients');
  const client = row(page, CLIENT.en).first();
  await expect(client).toContainText('Not cleared to name');

  await client.hover();
  await page.getByRole('button', { name: `Duplicate ${CLIENT.en}` }).click();
  await expect(page.locator('.toast', { hasText: 'Copied as a draft.' }).first()).toBeVisible();
  await expect(row(page, CLIENT.en)).toHaveCount(2);
  const copy = await serviceRow('clients', `${slug('client')}-copy`);
  expect(copy['visible']).toBe(false);
  expect(copy['is_placeholder']).toBe(false);
  const texts = await page.locator('ul.coll__list > li').allTextContents();
  const at = texts.findIndex((t) => t.includes(CLIENT.en));
  expect(texts[at + 1]).toContain(CLIENT.en);

  await row(page, CLIENT.en).first().locator('a.li__t').click();
  const drawer = dialog(page);
  await expect(drawer.getByRole('heading', { name: 'Edit client' })).toBeVisible();
  const visible = drawer.getByRole('switch', { name: 'Visible on the site' });
  await expect(visible).toHaveAttribute('aria-checked', 'false');
  await visible.click();
  await drawer.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await serviceRow('clients', slug('client')))['visible']).toBe(true);
  await expect(row(page, CLIENT.en).first()).not.toContainText('Not cleared to name');
});

test('numbers: a keyboard move reorders them', async ({ page }) => {
  await openScreen(page, '/admin/statistics');
  const second = NUMBER(2).en;
  const texts = await page.locator('ul.coll__list > li').allTextContents();
  expect(texts.findIndex((t) => t.includes(second))).toBe(
    texts.findIndex((t) => t.includes(NUMBER(1).en)) + 1,
  );

  await page.getByRole('button', { name: new RegExp(`^Reorder .*${second}`) }).focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  await expect(page.locator('.toast', { hasText: 'Order updated.' }).first()).toBeVisible();

  const one = Number((await serviceRow('statistics', slug('n1')))['sort_order']);
  const two = Number((await serviceRow('statistics', slug('n2')))['sort_order']);
  expect(two).toBeLessThan(one);
});

test('team members are never duplicated', async ({ page }) => {
  await openScreen(page, '/admin/team');
  await expect(page.locator('ul.coll__list > li').first()).toBeVisible();
  await page.locator('ul.coll__list > li').first().hover();
  await expect(page.getByRole('button', { name: /^Duplicate / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Edit / }).first()).toBeVisible();
});
