import { randomBytes } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { TENANT_ID } from '../../scripts/gen-seeds.mjs';
import { expectCleanAtWidths } from './collectionLayout';
import { SKIP_REASON, authFile, staffEnv } from './staff';

/*
 * The Services area (Admin v2 U5, AV-14), signed in, through the real Worker and this job's
 * local Supabase. On a discipline of this run's own (a draft, so no public page lists it) with
 * three services (two drafts and an archived one) and a sample case study:
 *
 *   overview      /admin/services lists it with its number, its count and its first services
 *                 as pills, its eye ("Show", it is a draft), at 320, 390 and 1280 px with zero
 *                 axe WCAG 2.2 A/AA violations and no sideways scroll;
 *   its page      the keyboard reorders its services (handle, Space, ArrowUp twice, Space): one
 *                 POST naming the two live services only, renumbered INSIDE the numbers the
 *                 discipline already held, the archived one untouched (a Content Creator may
 *                 not write it, H12);
 *   the eye       shows a draft service and hides it again (its discipline is a draft, so the
 *                 RESTRICTIVE services_discipline_published keeps it off the site either way);
 *   the editor    Content | Case study | SEO | Publishing for a Content Creator (no Leads),
 *                 at most 4 value cards, the case study's design-sample banner, made real in
 *                 one save of its own form; an archived service is read-only for them;
 *   Add service   the modal creates a draft in the discipline and opens its editor;
 *   Admin         the Leads tab and the "Leads by service" chart (counts only), Duplicate;
 *   SEO           the editor opens on its SEO tab, the content read-only, no "Add discipline";
 *   refused       GET /api/admin/leads/interest-counts is a 403 for the roles without leads;
 *   redirect      /admin/disciplines answers on the overview (302).
 *
 * Every row is made by the service role with a random marker in its slug and removed by it
 * afterwards. Nothing here publishes the discipline: the public suites count the seeded ones.
 */

test.skip(!staffEnv(), SKIP_REASON);
test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ mode: 'serial' });

const MARK = randomBytes(4).toString('hex');
const NAME = { en: `Discipline ${MARK}`, ar: `مجال ${MARK}` };
const S = {
  first: {
    slug: `e2e-s1-${MARK}`,
    title: { en: `First ${MARK}`, ar: `الأول ${MARK}` },
    status: 'draft',
    sort_order: 99910,
  },
  shelved: {
    slug: `e2e-s3-${MARK}`,
    title: { en: `Shelved ${MARK}`, ar: `مؤرشف ${MARK}` },
    status: 'archived',
    sort_order: 99920,
  },
  second: {
    slug: `e2e-s2-${MARK}`,
    title: { en: `Second ${MARK}`, ar: `الثاني ${MARK}` },
    status: 'draft',
    sort_order: 99930,
  },
} as const;
type Kind = keyof typeof S;
const CASE = { en: `Sample case ${MARK}`, ar: `حالة العينة ${MARK}` };

const ids: { discipline?: string } & Partial<Record<Kind, string>> = {};

function service() {
  const env = staffEnv()!;
  return createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

test.beforeAll(async () => {
  if (!staffEnv()) return;
  const svc = service();
  const { data: discipline, error } = await svc
    .from('disciplines')
    .insert({
      tenant_id: TENANT_ID,
      slug: `e2e-d-${MARK}`,
      name: NAME,
      status: 'draft',
      sort_order: 99990,
    })
    .select('id')
    .single();
  expect(error).toBeNull();
  ids.discipline = String(discipline!.id);
  const { data: rows, error: serviceError } = await svc
    .from('services')
    .insert(
      Object.values(S).map((row) => ({
        tenant_id: TENANT_ID,
        ...row,
        discipline_id: ids.discipline,
      })),
    )
    .select('id,slug');
  expect(serviceError).toBeNull();
  for (const kind of Object.keys(S) as Kind[]) {
    ids[kind] = String((rows ?? []).find((r) => r.slug === S[kind].slug)?.id);
  }
  const { error: caseError } = await svc.from('service_cases').insert({
    tenant_id: TENANT_ID,
    service_id: ids.first,
    title: CASE,
    is_placeholder: true,
    status: 'draft',
  });
  expect(caseError).toBeNull();
});

test.afterAll(async () => {
  if (!staffEnv()) return;
  const svc = service();
  const { data } = await svc.from('services').select('id').like('slug', `%${MARK}%`);
  const serviceIds = (data ?? []).map((r) => r.id as string);
  if (serviceIds.length > 0) {
    await svc.from('service_cases').delete().in('service_id', serviceIds);
    await svc.from('services').delete().in('id', serviceIds);
  }
  await svc.from('disciplines').delete().like('slug', `e2e-d-${MARK}`);
});

async function ready(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
}

/** A row action: focus, then Enter (row actions show on hover or focus, H12/U7's lesson). */
async function press(button: Locator) {
  await button.focus();
  await button.press('Enter');
}

async function stored(kind: Kind) {
  const { data, error } = await service()
    .from('services')
    .select('sort_order,status,version,title')
    .eq('id', ids[kind]!)
    .single();
  expect(error).toBeNull();
  return data as { sort_order: number; status: string; version: number; title: { en: string } };
}

const serviceList = (page: Page) => page.getByRole('list', { name: 'Services in this discipline' });

test.describe('as content_creator', () => {
  test.use({ storageState: authFile('content_creator') });

  test('the overview lists the discipline with its number, count and pills', async ({ page }) => {
    await ready(page, '/admin/services');
    const list = page.getByRole('list', { name: 'Disciplines' });
    const row = list.locator('li', { hasText: NAME.en });
    await expect(row).toHaveCount(1);
    await expect(row.locator('a.li__t')).toHaveText(new RegExp(`^\\d{2} · ${NAME.en}$`));
    await expect(row).toContainText('3 services');
    await expect(row.locator('.svc__pills .badge')).toHaveText([
      S.first.title.en,
      S.shelved.title.en,
      S.second.title.en,
    ]);
    await expect(row.locator('.badge').filter({ hasText: /^Draft$/ })).toHaveCount(1);
    await expect(row.getByRole('button', { name: `Show ${NAME.en}` })).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Add discipline' })).toBeVisible();
    await expectCleanAtWidths(page, 'the services overview');
  });

  test('a keyboard move reorders the services inside the discipline’s own numbers', async ({
    page,
  }) => {
    await ready(page, `/admin/disciplines/${ids.discipline}`);
    await expect(page.locator('h1')).toContainText(NAME.en);
    const list = serviceList(page);
    await expect(list.locator('a.li__t')).toHaveText([
      S.first.title.en,
      S.shelved.title.en,
      S.second.title.en,
    ]);
    await expectCleanAtWidths(page, 'the discipline page');
    const shelvedBefore = await stored('shelved');

    const reorder = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === '/api/admin/services/reorder' &&
        res.request().method() === 'POST',
    );
    await page.getByRole('button', { name: `Reorder ${S.second.title.en}`, exact: true }).focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Space');
    const response = await reorder;
    expect(response.status(), await response.text()).toBe(200);
    // The two live services swap the numbers they held; the archived one is not named.
    expect(response.request().postDataJSON()).toEqual({
      items: [
        { id: ids.second, sortOrder: S.first.sort_order },
        { id: ids.first, sortOrder: S.second.sort_order },
      ],
    });
    await expect(page.locator('.toast', { hasText: 'Order updated.' }).first()).toBeVisible();
    expect((await stored('second')).sort_order).toBe(S.first.sort_order);
    expect((await stored('first')).sort_order).toBe(S.second.sort_order);
    expect(await stored('shelved')).toEqual(shelvedBefore);
    await expect(list.locator('a.li__t')).toHaveText([
      S.second.title.en,
      S.shelved.title.en,
      S.first.title.en,
    ]);
  });

  test('the eye shows a draft service and hides it again; an archived one has none', async ({
    page,
  }) => {
    await ready(page, `/admin/disciplines/${ids.discipline}`);
    const list = serviceList(page);
    await expect(list.getByRole('button', { name: `Show ${S.shelved.title.en}` })).toHaveCount(0);
    await expect(list.getByRole('button', { name: `Hide ${S.shelved.title.en}` })).toHaveCount(0);

    await press(list.getByRole('button', { name: `Show ${S.second.title.en}` }));
    await expect.poll(async () => (await stored('second')).status).toBe('published');
    await expect(list.getByRole('button', { name: `Hide ${S.second.title.en}` })).toBeVisible();
    await press(list.getByRole('button', { name: `Hide ${S.second.title.en}` }));
    await expect.poll(async () => (await stored('second')).status).toBe('draft');
  });

  test('an archived service is read-only for a role that may not archive', async ({ page }) => {
    await ready(page, `/admin/services/${ids.shelved}`);
    await expect(page.locator('#f-title-en')).toHaveValue(S.shelved.title.en);
    await expect(
      page.getByText('This service is archived. Only an Admin can change it.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0);
    await expect(page.locator('#f-title-en')).toBeDisabled();
  });

  test('the editor’s tabs, at most 4 value cards, and the sample case made real in one save', async ({
    page,
  }) => {
    page.on('dialog', (dialog) => void dialog.accept());
    await ready(page, `/admin/services/${ids.first}`);
    const tabs = page.getByRole('tablist', { name: 'Service editor' });
    await expect(tabs.getByRole('tab')).toHaveText(['Content', 'Case study', 'SEO', 'Publishing']);
    await expect(page.locator('#f-title-en')).toHaveValue(S.first.title.en);
    await expectCleanAtWidths(page, 'the service editor, Content');

    for (let n = 0; n < 4; n++) {
      await page.getByRole('button', { name: 'Add value cards', exact: true }).click();
    }
    await expect(page.getByRole('button', { name: 'At most 4', exact: true })).toBeDisabled();

    await tabs.getByRole('tab', { name: 'Case study', exact: true }).click();
    await expect(page.getByText('This is a design sample.', { exact: false })).toBeVisible();
    const headline = page.locator('#fc-title-en');
    await expect(headline).toHaveValue(CASE.en);
    await expectCleanAtWidths(page, 'the service editor, Case study');

    const real = `Real case ${MARK}`;
    await headline.fill(real);
    const sample = page.getByRole('switch', { name: 'Placeholder (design sample)' });
    await expect(sample).toHaveAttribute('aria-checked', 'true');
    await sample.click();
    const saved = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname.startsWith('/api/admin/service-cases/') &&
        res.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: 'Save case study', exact: true }).click();
    const savedRes = await saved;
    expect(savedRes.status(), await savedRes.text()).toBe(200);
    const { data, error } = await service()
      .from('service_cases')
      .select('title,is_placeholder')
      .eq('service_id', ids.first!)
      .single();
    expect(error).toBeNull();
    expect(data).toMatchObject({ is_placeholder: false, title: { en: real, ar: CASE.ar } });
    await expect(page.getByText('This is a design sample.', { exact: false })).toHaveCount(0);
  });

  test('Add service creates a draft in the discipline and opens its editor', async ({ page }) => {
    await ready(page, `/admin/disciplines/${ids.discipline}`);
    await page.getByRole('link', { name: 'Add service' }).click();
    const modal = page.getByRole('dialog', { name: 'Add a service' });
    await expect(modal).toBeVisible();
    await expectCleanAtWidths(page, 'the Add service modal');
    await modal.locator('#f-title-en').fill(`Added ${MARK}`);
    await modal.locator('#f-title-ar').fill(`مضاف ${MARK}`);
    await expect(modal.locator('#f-slug')).toHaveValue(`added-${MARK}`);
    await modal.getByRole('button', { name: 'Create service', exact: true }).click();
    await page.waitForURL((url) => /^\/admin\/services\/[0-9a-f-]{36}$/.test(url.pathname));
    const { data, error } = await service()
      .from('services')
      .select('status,discipline_id,sort_order')
      .eq('slug', `added-${MARK}`)
      .single();
    expect(error).toBeNull();
    expect(data).toMatchObject({ status: 'draft', discipline_id: ids.discipline });
    // After the discipline's last service, inside its range.
    expect(Number(data!.sort_order)).toBeGreaterThan(S.second.sort_order);
  });

  test('the lead counts are refused to a role that does not work leads', async ({ page }) => {
    const res = await page.request.get('/api/admin/leads/interest-counts');
    expect(res.status(), await res.text()).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: 'forbidden' });
  });
});

test.describe('as admin', () => {
  test.use({ storageState: authFile('admin') });

  test('the Leads tab and the leads by service, counts only', async ({ page }) => {
    const counts = await page.request.get('/api/admin/leads/interest-counts');
    expect(counts.status(), await counts.text()).toBe(200);
    const body = (await counts.json()) as { data: { counts: Record<string, number> } };
    for (const [slug, n] of Object.entries(body.data.counts)) {
      expect(slug).toMatch(/^[a-z0-9-]+$/);
      expect(Number.isInteger(n)).toBe(true);
    }

    await ready(page, `/admin/disciplines/${ids.discipline}`);
    await expect(page.getByRole('heading', { name: 'Leads by service' })).toBeVisible();
    await expect(
      page.getByRole('list', { name: 'Leads by service' }).locator('li'),
    ).not.toHaveCount(0);
    await expect(
      serviceList(page)
        .locator('.badge', { hasText: /^No leads$/ })
        .first(),
    ).toBeVisible();

    await ready(page, `/admin/services/${ids.first}`);
    const tabs = page.getByRole('tablist', { name: 'Service editor' });
    await expect(tabs.getByRole('tab')).toHaveText([
      'Content',
      'Case study',
      'SEO',
      'Leads',
      'Publishing',
    ]);
    await tabs.getByRole('tab', { name: 'Leads', exact: true }).click();
    await expect(page.getByText('No leads for this service yet')).toBeVisible();
    await expectCleanAtWidths(page, 'the service editor, Leads');
  });

  test('Duplicate makes a draft copy and opens it', async ({ page }) => {
    await ready(page, `/admin/services/${ids.first}`);
    await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
    await page.waitForURL(
      (url) =>
        /^\/admin\/services\/[0-9a-f-]{36}$/.test(url.pathname) &&
        !url.pathname.endsWith(ids.first!),
    );
    const { data, error } = await service()
      .from('services')
      .select('status,title,discipline_id')
      .eq('slug', `${S.first.slug}-copy`)
      .single();
    expect(error).toBeNull();
    expect(data).toMatchObject({
      status: 'draft',
      discipline_id: ids.discipline,
      title: { en: `${S.first.title.en} (copy)` },
    });
    // The case study is not copied: the copy has none.
    await page.getByRole('tab', { name: 'Case study', exact: true }).click();
    await expect(page.getByText('No case study yet')).toBeVisible();

    // An Admin deletes it from the editor (main's list row action, kept): asked first, then
    // back on the overview saying so, and the row is gone.
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    const ask = page.getByRole('dialog').filter({ hasText: 'This cannot be undone.' });
    await expect(ask).toContainText(`${S.first.title.en} (copy)`);
    const gone = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname.startsWith('/api/admin/services/') &&
        res.request().method() === 'DELETE',
    );
    await ask.getByRole('button', { name: 'Delete', exact: true }).click();
    const goneRes = await gone;
    expect(goneRes.status(), await goneRes.text()).toBe(200);
    await page.waitForURL((url) => url.pathname === '/admin/services');
    await expect(page.locator('#admin-toasts')).toContainText('Service deleted');
    const { data: left } = await service()
      .from('services')
      .select('id')
      .eq('slug', `${S.first.slug}-copy`)
      .maybeSingle();
    expect(left).toBeNull();
  });
});

test.describe('as seo', () => {
  test.use({ storageState: authFile('seo') });

  test('the editor opens on SEO; the content is read-only; nothing to add', async ({ page }) => {
    await ready(page, `/admin/services/${ids.first}`);
    const tabs = page.getByRole('tablist', { name: 'Service editor' });
    await expect(tabs.getByRole('tab')).toHaveText(['Content', 'SEO', 'Publishing']);
    await expect(tabs.getByRole('tab', { name: 'SEO', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await tabs.getByRole('tab', { name: 'Content', exact: true }).click();
    await expect(
      page.getByText('You can read this service. Your role changes its SEO only.'),
    ).toBeVisible();
    await expect(page.locator('#f-title-en')).toBeDisabled();

    await ready(page, '/admin/services');
    await expect(page.getByRole('list', { name: 'Disciplines' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Add discipline' })).toHaveCount(0);

    const res = await page.request.get('/api/admin/leads/interest-counts');
    expect(res.status()).toBe(403);
  });

  test('/admin/disciplines answers on the overview', async ({ page }) => {
    const res = await page.request.get('/admin/disciplines', { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    expect(res.headers()['location']).toBe('/admin/services');
  });
});
