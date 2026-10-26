import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { TENANT_ID } from '../../scripts/gen-seeds.mjs';
import { expectCleanAtWidths } from './collectionLayout';
import { SKIP_REASON, authFile, staffEnv } from './staff';

/*
 * The Projects area (Admin v2 U6, AV-15), signed in, through the real Worker and this job's
 * local Supabase. On a project of this run's own (a draft: no public page lists it) with a
 * hero picture, one breakdown item and two gallery pictures:
 *
 *   the list      the search finds it by its name and by its type; the Hidden chip keeps it
 *                 (a draft); at 320, 390 and 1280 px with zero axe WCAG 2.2 A/AA violations
 *                 and no sideways scroll;
 *   Manage tags   the wide drawer: a sector added in place, the clients and the services' note;
 *   Add project   the modal creates a draft (never a copy of another project) and opens it;
 *   the editor    Basics | Case study | Breakdown & gallery | SEO | Publishing; the gallery
 *                 reordered from the keyboard (handle, Space, ArrowLeft, Space) and saved in
 *                 ONE PATCH (one save_portfolio call), the hero and the breakdown untouched;
 *                 a breakdown item added (it stays while it holds nothing yet, and when its
 *                 picture is removed), its kind and picture chosen, and saved in ONE PATCH;
 *                 the publish requirements say the poster is missing; "Add a quote" opens the
 *                 testimonial drawer with this project chosen;
 *   SEO           the editor opens on its SEO tab, the content read-only, no testimonial card,
 *                 and the list offers no Add project, Manage tags or moves.
 *
 * Every row is made by the service role with a random marker in its slug and removed by it
 * afterwards; the pictures are the seed's own stills, linked, never changed.
 */

test.skip(!staffEnv(), SKIP_REASON);
test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ mode: 'serial' });

const MARK = randomBytes(4).toString('hex');
const TITLE = { en: `Project ${MARK}`, ar: `مشروع ${MARK}` };
const TYPE = { en: `Film ${MARK}`, ar: `فيلم ${MARK}` };
let projectId = '';
let stills: string[] = [];

function service() {
  const env = staffEnv()!;
  return createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

test.beforeAll(async () => {
  if (!staffEnv()) return;
  const svc = service();
  const { data: media, error: mediaError } = await svc
    .from('media_assets')
    .select('id')
    .eq('tenant_id', TENANT_ID)
    .eq('kind', 'image')
    .eq('provider', 'static')
    .order('id')
    .limit(3);
  expect(mediaError).toBeNull();
  stills = (media ?? []).map((m) => String(m.id));
  expect(stills, 'three seeded stills').toHaveLength(3);
  const { data, error } = await svc
    .from('portfolio')
    .insert({
      tenant_id: TENANT_ID,
      slug: `e2e-p-${MARK}`,
      title: TITLE,
      project_type: TYPE,
      status: 'draft',
      sort_order: 9950,
    })
    .select('id')
    .single();
  expect(error).toBeNull();
  projectId = String(data!.id);
  const { error: itemsError } = await svc.from('portfolio_media').insert([
    {
      tenant_id: TENANT_ID,
      portfolio_id: projectId,
      role: 'hero',
      kind: 'image',
      media_id: stills[0],
      sort_order: 0,
    },
    {
      tenant_id: TENANT_ID,
      portfolio_id: projectId,
      role: 'breakdown',
      kind: 'image',
      media_id: stills[0],
      breakdown_kind: 'sketch',
      sort_order: 1,
    },
    {
      tenant_id: TENANT_ID,
      portfolio_id: projectId,
      role: 'gallery',
      kind: 'image',
      media_id: stills[1],
      sort_order: 2,
    },
    {
      tenant_id: TENANT_ID,
      portfolio_id: projectId,
      role: 'gallery',
      kind: 'image',
      media_id: stills[2],
      sort_order: 3,
    },
  ]);
  expect(itemsError).toBeNull();
});

test.afterAll(async () => {
  if (!staffEnv()) return;
  const svc = service();
  const { data } = await svc.from('portfolio').select('id').like('slug', `%${MARK}%`);
  const ids = (data ?? []).map((r) => r.id as string);
  if (ids.length > 0) {
    await svc.from('portfolio_media').delete().in('portfolio_id', ids);
    await svc.from('portfolio_services').delete().in('portfolio_id', ids);
    await svc.from('portfolio').delete().in('id', ids);
  }
  await svc.from('sectors').delete().like('slug', `%${MARK}%`);
});

async function ready(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
}

/** The project's media as stored: role and picture, in order. */
async function storedMedia(): Promise<[string, string][]> {
  const { data, error } = await service()
    .from('portfolio_media')
    .select('role,media_id,sort_order')
    .eq('portfolio_id', projectId)
    .order('sort_order');
  expect(error).toBeNull();
  return (data ?? []).map((r) => [String(r.role), String(r.media_id)]);
}

const links = (page: Page) => page.locator('table.data a.data-link');

test.describe('as content_creator', () => {
  test.use({ storageState: authFile('content_creator') });

  test('the list: search by name and by type, the Hidden chip, every width', async ({ page }) => {
    await ready(page, '/admin/portfolio');
    await expect(links(page).first()).toBeVisible();
    await expectCleanAtWidths(page, 'the projects list');

    const search = page.getByLabel('Search projects', { exact: true });
    await search.fill(TITLE.en);
    await expect(links(page)).toHaveText([TITLE.en]);
    await search.fill(TITLE.ar);
    await expect(links(page)).toHaveText([TITLE.en]);
    await search.fill(TYPE.en);
    await expect(links(page)).toHaveText([TITLE.en]);
    await page.getByRole('button', { name: 'Hidden', exact: true }).click();
    await expect(links(page)).toHaveText([TITLE.en]);
    await page.getByRole('button', { name: 'Featured', exact: true }).click();
    await expect(page.getByText('No projects match')).toBeVisible();
  });

  test('Manage tags: a sector added in place, the clients, the services’ note', async ({
    page,
  }) => {
    await ready(page, '/admin/portfolio');
    await page.getByRole('link', { name: 'Manage tags' }).click();
    const drawer = page.getByRole('dialog', { name: 'Tags and filters' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('heading', { name: 'Sectors' })).toBeVisible();
    await expect(drawer.getByRole('heading', { name: 'Clients' })).toBeVisible();
    await expect(drawer.getByRole('link', { name: 'Edit them in Services' })).toBeVisible();
    await expectCleanAtWidths(page, 'the tags drawer');

    await drawer.getByRole('button', { name: 'Add sector', exact: true }).click();
    await drawer.locator('#ft-slug').fill(`e2e-sector-${MARK}`);
    await drawer.locator('#ft-name-en').fill(`Sector ${MARK}`);
    await drawer.locator('#ft-name-ar').fill(`قطاع ${MARK}`);
    await drawer.getByRole('button', { name: 'Add sector', exact: true }).click();
    await expect(drawer.getByText(`Sector ${MARK}`)).toBeVisible();
    const { data, error } = await service()
      .from('sectors')
      .select('name,visible')
      .eq('slug', `e2e-sector-${MARK}`)
      .single();
    expect(error).toBeNull();
    expect(data).toMatchObject({
      name: { en: `Sector ${MARK}`, ar: `قطاع ${MARK}` },
      visible: true,
    });
  });

  test('Add project creates a draft and opens it', async ({ page }) => {
    await ready(page, '/admin/portfolio');
    await page.getByRole('link', { name: 'Add project' }).click();
    const modal = page.getByRole('dialog', { name: 'Add a project' });
    await expect(modal).toBeVisible();
    await modal.locator('#f-title-en').fill(`Added project ${MARK}`);
    await modal.locator('#f-title-ar').fill(`مشروع مضاف ${MARK}`);
    await modal.locator('#f-projectType-en').fill('Brand film');
    await modal.locator('#f-projectType-ar').fill('فيلم');
    await expect(modal.locator('#f-slug')).toHaveValue(`added-project-${MARK}`);
    await modal.getByRole('button', { name: 'Create project', exact: true }).click();
    await page.waitForURL((url) => /^\/admin\/portfolio\/[0-9a-f-]{36}$/.test(url.pathname));
    const { data, error } = await service()
      .from('portfolio')
      .select('status,is_featured,poster_media_id')
      .eq('slug', `added-project-${MARK}`)
      .single();
    expect(error).toBeNull();
    // Empty but for what was asked: never another project's copy.
    expect(data).toEqual({ status: 'draft', is_featured: false, poster_media_id: null });
  });

  test('the editor: the gallery reordered from the keyboard, saved in one call', async ({
    page,
  }) => {
    page.on('dialog', (dialog) => void dialog.accept());
    await ready(page, `/admin/portfolio/${projectId}`);
    const tabs = page.getByRole('tablist', { name: 'Project editor' });
    await expect(tabs.getByRole('tab')).toHaveText([
      'Basics',
      'Case study',
      'Breakdown & gallery',
      'SEO',
      'Publishing',
    ]);
    await expect(page.locator('#f-title-en')).toHaveValue(TITLE.en);
    await expect(page.getByRole('group', { name: 'Hero banner' })).toBeVisible();
    await expectCleanAtWidths(page, 'the project editor, Basics');

    await tabs.getByRole('tab', { name: 'Breakdown & gallery', exact: true }).click();
    const gallery = page.getByRole('list', { name: 'Gallery' });
    await expect(gallery.locator('li')).toHaveCount(2);
    await expectCleanAtWidths(page, 'the project editor, Breakdown & gallery');
    const before = await storedMedia();
    expect(before.filter(([role]) => role === 'gallery').map(([, id]) => id)).toEqual([
      stills[1],
      stills[2],
    ]);

    await page.getByRole('button', { name: 'Reorder Image 2', exact: true }).focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Space');

    const writes: string[] = [];
    page.on('request', (req) => {
      if (req.method() !== 'GET' && new URL(req.url()).pathname.startsWith('/api/admin/')) {
        writes.push(`${req.method()} ${new URL(req.url()).pathname}`);
      }
    });
    const saved = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === `/api/admin/portfolio/${projectId}` &&
        res.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    const response = await saved;
    expect(response.status(), await response.text()).toBe(200);
    expect(writes).toEqual([`PATCH /api/admin/portfolio/${projectId}`]);

    const after = await storedMedia();
    expect(after.filter(([role]) => role === 'gallery').map(([, id]) => id)).toEqual([
      stills[2],
      stills[1],
    ]);
    // The other roles' items came back whole, the set in one order (hero, film, breakdown, gallery).
    expect(after.map(([role]) => role)).toEqual(['hero', 'breakdown', 'gallery', 'gallery']);
    expect(after.find(([role]) => role === 'hero')?.[1]).toBe(stills[0]);
  });

  test('the editor: a breakdown item added, its picture chosen, saved in one call', async ({
    page,
  }) => {
    page.on('dialog', (dialog) => void dialog.accept());
    await ready(page, `/admin/portfolio/${projectId}?tab=breakdown`);
    const items = page.getByRole('list', { name: 'Breakdown', exact: true }).locator(':scope > li');
    await expect(items).toHaveCount(1);
    // The new item stays while it holds nothing yet, and while only its kind is chosen.
    await page.getByRole('button', { name: 'Add breakdown', exact: true }).click();
    await expect(items).toHaveCount(2);
    await page.locator('#f-breakdown-1-breakdownKind').selectOption('process');
    await expect(items).toHaveCount(2);

    const picture = items.nth(1).getByRole('group', { name: 'Picture, or the video’s poster' });
    const choose = async () => {
      await picture.getByRole('button', { name: /^(Choose|Change)…$/ }).click();
      const picker = page.getByRole('dialog', { name: 'Picture, or the video’s poster: choose' });
      await expect(picker).toBeVisible();
      const tile = picker.locator('button.mi[aria-pressed]').first();
      await tile.click();
      await expect(tile).toHaveAttribute('aria-pressed', 'true');
      await picker.getByRole('button', { name: 'Use image', exact: true }).click();
      await expect(picker).toBeHidden();
    };
    await choose();
    // Removing the picture keeps the item and its kind; then it is chosen again.
    await picture.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(items).toHaveCount(2);
    await expect(page.locator('#f-breakdown-1-breakdownKind')).toHaveValue('process');
    await choose();

    const writes: string[] = [];
    page.on('request', (req) => {
      if (req.method() !== 'GET' && new URL(req.url()).pathname.startsWith('/api/admin/')) {
        writes.push(`${req.method()} ${new URL(req.url()).pathname}`);
      }
    });
    const saved = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === `/api/admin/portfolio/${projectId}` &&
        res.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    const response = await saved;
    expect(response.status(), await response.text()).toBe(200);
    expect(writes).toEqual([`PATCH /api/admin/portfolio/${projectId}`]);

    const { data, error } = await service()
      .from('portfolio_media')
      .select('role,kind,breakdown_kind,media_id')
      .eq('portfolio_id', projectId)
      .eq('role', 'breakdown')
      .order('sort_order');
    expect(error).toBeNull();
    expect((data ?? []).map((r) => [r.kind, r.breakdown_kind])).toEqual([
      ['image', 'sketch'],
      ['image', 'process'],
    ]);
    expect(data?.[1]?.media_id, 'the chosen picture').toBeTruthy();
    expect((await storedMedia()).map(([role]) => role)).toEqual([
      'hero',
      'breakdown',
      'breakdown',
      'gallery',
      'gallery',
    ]);
  });

  test('the publish requirements and the testimonial card', async ({ page }) => {
    await ready(page, `/admin/portfolio/${projectId}?tab=publishing`);
    const reqs = page.getByRole('region', { name: 'Before it can be published' });
    await expect(reqs).toBeVisible();
    await expect(reqs).toContainText('things to do before it can be published');
    await expect(
      reqs.locator('li:not([data-met])', { hasText: 'A poster (the card image)' }),
    ).toHaveCount(1);
    await expect(
      reqs.locator('li[data-met]', { hasText: 'The name in English and Arabic' }),
    ).toHaveCount(1);
    await expectCleanAtWidths(page, 'the project editor, Publishing');

    await page.getByRole('tab', { name: 'Case study', exact: true }).click();
    const quotes = page.getByRole('region', { name: 'Testimonial on the project page' });
    await expect(quotes).toBeVisible();
    await expect(quotes).toContainText('No quote is linked to this project yet.');
    await quotes.getByRole('link', { name: 'Add a quote' }).click();
    await page.waitForURL((url) => url.pathname === '/admin/testimonials/new');
    await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('heading', { name: 'New quote' })).toBeVisible();
    await expect(drawer.locator('#f-portfolioId')).toHaveValue(projectId);
  });
});

test.describe('as seo', () => {
  test.use({ storageState: authFile('seo') });

  test('the editor opens on SEO, the rest read-only; the list offers no writes', async ({
    page,
  }) => {
    await ready(page, `/admin/portfolio/${projectId}`);
    const tabs = page.getByRole('tablist', { name: 'Project editor' });
    await expect(tabs.getByRole('tab', { name: 'SEO', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await tabs.getByRole('tab', { name: 'Basics', exact: true }).click();
    await expect(
      page.getByText('You can read this project. Your role changes its SEO only.'),
    ).toBeVisible();
    await expect(page.locator('#f-title-en')).toBeDisabled();
    await tabs.getByRole('tab', { name: 'Case study', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Testimonial on the project page' })).toHaveCount(
      0,
    );

    await ready(page, '/admin/portfolio');
    await expect(links(page).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Add project' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Manage tags' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Move .* (up|down)$/ })).toHaveCount(0);
  });
});
