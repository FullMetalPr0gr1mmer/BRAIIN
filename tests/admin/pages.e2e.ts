import { randomBytes } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { TENANT_ID } from '../../scripts/gen-seeds.mjs';
import { ABOUT_WHO_COPY } from '@/lib/sections/copy/aboutWho';
import { CTA_COPY } from '@/lib/sections/copy/cta';
import { expectCleanAtWidths } from './collectionLayout';
import { SKIP_REASON, authFile, staffEnv } from './staff';

/*
 * Pages and the page editor (Admin v2 E1), signed in, through the real Worker, releases off:
 *
 *   every width  the list, the editor on About, and the editor with each drawer (SEO, History)
 *                and dialog (Add a section, Rename section) open, as Admin; as a Content
 *                Creator with the SEO drawer read only; as SEO with its SEO drawer: zero axe
 *                WCAG 2.2 A/AA violations and no sideways scroll at 320, 390 and 1280 px;
 *   About        the sections in the site's order, the first open, its fields prefilled with
 *                the words the page shows (the built-in copy, nothing stored);
 *   a scratch    a page of this run's own (no route shows it, so no visitor sees any of this),
 *   page         with two sections made by the service role: Move down, the eye, Rename, a
 *                heading's words saved as the only difference stored, the switch that asks
 *                before unsaved words are dropped, English / العربية / Both and "Arabic
 *                missing" with Next gap for the whole screen, History, and the page details;
 *   Add section  on About, as Admin: the kinds it may not take say why; a call to action is
 *                added hidden at the end, then deleted (a hidden section renders nowhere);
 *   per role     a Content Creator edits sections but deletes none ("hide it instead"); SEO
 *                gets the SEO drawer only; Developer and Sales are refused by the server.
 *
 * Every row this suite writes is its own (the scratch page, the added section), removed by the
 * service role afterwards whatever failed.
 */

test.skip(!staffEnv(), SKIP_REASON);
test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ mode: 'serial' });

const MARK = randomBytes(4).toString('hex');
const SLUG = `e2e-page-${MARK}`;
const TITLE = { en: `Scratch ${MARK}`, ar: `مسودة ${MARK}` };

let scratchId = '';
let aboutId = '';
const added: string[] = [];

function service() {
  const env = staffEnv()!;
  return createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function sectionRow(id: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await service()
    .from('page_sections')
    .select('id,type,label,content,visible,sort_order')
    .eq('id', id)
    .maybeSingle();
  expect(error).toBeNull();
  return data as Record<string, unknown> | null;
}

test.beforeAll(async () => {
  if (!staffEnv()) return;
  const svc = service();
  const about = await svc
    .from('pages')
    .select('id')
    .eq('tenant_id', TENANT_ID)
    .eq('slug', 'about')
    .single();
  expect(about.error).toBeNull();
  aboutId = String((about.data as { id: string }).id);
  const created = await svc
    .from('pages')
    .insert({ tenant_id: TENANT_ID, slug: SLUG, title: TITLE, status: 'draft' })
    .select('id')
    .single();
  expect(created.error).toBeNull();
  scratchId = String((created.data as { id: string }).id);
  const sections = await svc.from('page_sections').insert([
    { tenant_id: TENANT_ID, page_id: scratchId, type: 'cta', visible: true, sort_order: 10 },
    { tenant_id: TENANT_ID, page_id: scratchId, type: 'slogan', visible: false, sort_order: 20 },
  ]);
  expect(sections.error).toBeNull();
});

test.afterAll(async () => {
  if (!staffEnv()) return;
  const svc = service();
  if (added.length > 0) await svc.from('page_sections').delete().in('id', added);
  if (scratchId) await svc.from('pages').delete().eq('id', scratchId);
});

async function open(page: Page, path: string) {
  const res = await page.goto(path, { waitUntil: 'networkidle' });
  expect(res?.status(), path).toBe(200);
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  await page.waitForLoadState('networkidle');
}

/** The sections column, once the island has read the sections. */
const column = (page: Page) => page.getByRole('complementary', { name: 'Sections' });
/** A section's row in the column, by its name (the open button's name starts with it). */
const rowOf = (page: Page, name: string) =>
  column(page)
    .locator('li.pe__row')
    .filter({ has: page.getByRole('button', { name: new RegExp(`^${name},`) }) });
const pick = (page: Page, name: string) =>
  column(page).getByRole('button', { name: new RegExp(`^${name},`) });

/** A row control: focus, then Enter (the kit's rule for row actions). */
async function press(control: Locator) {
  await control.focus();
  await control.press('Enter');
}

async function openEditor(page: Page, id: string) {
  await open(page, `/admin/pages/${id}`);
  await expect(column(page).locator('li.pe__row[aria-current="true"]')).toHaveCount(1);
  await expect(page.locator('form.editor')).toBeVisible();
}

test.describe('as admin', () => {
  test.use({ storageState: authFile('admin') });

  test('the list: a card per page and the templates, clean at every width', async ({ page }) => {
    await open(page, '/admin/pages');
    const cards = page.getByRole('list', { name: 'The site’s pages' });
    await expect(cards.getByRole('link', { name: 'Edit About' })).toHaveAttribute(
      'href',
      `/admin/pages/${aboutId}`,
    );
    const about = cards.locator('li', { has: page.getByRole('link', { name: 'Edit About' }) });
    await expect(about).toContainText('/about · 4 sections');
    await expect(about.getByRole('link', { name: 'Open About on the site' })).toHaveAttribute(
      'href',
      '/about',
    );
    await expect(about.getByRole('link', { name: 'Open About in Arabic' })).toHaveAttribute(
      'href',
      '/ar/about',
    );
    await expect(about.getByRole('link', { name: 'Who can see About' })).toHaveAttribute(
      'href',
      '/admin/visibility',
    );
    await expect(cards.getByRole('link', { name: `Edit ${TITLE.en}` })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Service page' })).toHaveAttribute(
      'href',
      '/admin/services',
    );
    await expect(page.getByRole('link', { name: 'Project page' })).toHaveAttribute(
      'href',
      '/admin/portfolio',
    );
    // "New page" waits for custom pages (E11).
    await expect(page.locator('main').getByRole('link', { name: 'New page' })).toHaveCount(0);
    await expectCleanAtWidths(page, 'the pages list');
  });

  test('About: the sections in order, the first open with the words the page shows', async ({
    page,
  }) => {
    await openEditor(page, aboutId);
    await expect(column(page).locator('li.pe__row .pe__name')).toHaveText([
      'Page details',
      'Who we are',
      'Leadership',
      'Numbers',
      'Social links',
    ]);
    await expect(rowOf(page, 'Who we are')).toHaveAttribute('aria-current', 'true');
    await expect(page).toHaveURL(/\?section=[0-9a-f-]{36}$/);
    const fields = page.getByRole('region', { name: 'Who we are' });
    await expect(fields).toContainText('Section type: Who we are · anchor #who');
    // Nothing stored for the heading (the seed stores a picture and a clip only): it shows the
    // built-in words, in both languages.
    await expect(page.locator('#f-content-heading-en')).toHaveValue(ABOUT_WHO_COPY.heading.en);
    await expect(page.locator('#f-content-heading-ar')).toHaveValue(ABOUT_WHO_COPY.heading.ar);
    // The bar: an Admin sets visibility; the page opens in both languages.
    const bar = page.getByRole('group', { name: 'This page' });
    await expect(bar.getByRole('link', { name: 'Visibility' })).toHaveAttribute(
      'href',
      '/admin/visibility',
    );
    await expect(bar.getByRole('link', { name: 'Open page in Arabic' })).toHaveAttribute(
      'href',
      '/ar/about',
    );
    // Nothing of releases while they are off.
    await expect(bar.getByRole('button', { name: 'Publish…' })).toHaveCount(0);
    await expect(page.locator('astro-island[component-url*="AdminSavebar"]')).toHaveCount(0);
    await expectCleanAtWidths(page, 'the page editor');
  });

  test('each drawer and dialog, clean at every width', async ({ page }) => {
    await openEditor(page, aboutId);
    const bar = page.getByRole('group', { name: 'This page' });

    await bar.getByRole('button', { name: 'SEO' }).click();
    const seo = page.getByRole('dialog', { name: 'SEO: About' });
    await expect(seo.getByRole('button', { name: 'Save SEO' })).toBeVisible();
    await expectCleanAtWidths(page, 'the SEO drawer');
    await page.keyboard.press('Escape');
    await expect(seo).toBeHidden();

    await bar.getByRole('button', { name: 'History' }).click();
    const history = page.getByRole('dialog', { name: 'History: Who we are' });
    await expect(history.getByRole('heading', { name: 'Saves' })).toBeVisible();
    await expect(history.locator('.tl__i').first()).toContainText('Saved by');
    await expectCleanAtWidths(page, 'the History drawer');
    await page.keyboard.press('Escape');
    await expect(history).toBeHidden();

    await column(page).getByRole('button', { name: 'Add section' }).click();
    const library = page.getByRole('dialog', { name: 'Add a section' });
    await expect(library.getByRole('button', { name: 'Call to action' })).toBeVisible();
    await expectCleanAtWidths(page, 'Add a section');
    await page.keyboard.press('Escape');
    await expect(library).toBeHidden();

    await page.getByRole('button', { name: 'Rename' }).click();
    const rename = page.getByRole('dialog', { name: 'Rename section' });
    await expect(rename.getByLabel('Section name')).toHaveValue('');
    await expectCleanAtWidths(page, 'Rename section');
    await rename.getByRole('button', { name: 'Cancel' }).click();
    await expect(rename).toBeHidden();
  });

  test('a scratch page: move, show, rename, its words, the language bar, history', async ({
    page,
  }) => {
    await openEditor(page, scratchId);
    await expect(column(page).locator('li.pe__row .pe__name')).toHaveText([
      'Page details',
      'Call to action',
      'Slogan band',
    ]);
    const idOf = async (type: string) => {
      const { data } = await service()
        .from('page_sections')
        .select('id')
        .eq('page_id', scratchId)
        .eq('type', type)
        .single();
      return String((data as { id: string }).id);
    };
    const ctaId = await idOf('cta');
    const sloganId = await idOf('slogan');
    await expect(rowOf(page, 'Call to action')).toHaveAttribute('aria-current', 'true');

    // Move down: the two swap, on the page and in the database.
    await press(page.getByRole('button', { name: 'Move Call to action down' }));
    await expect(
      page.locator('.toast', { hasText: 'Section order updated.' }).first(),
    ).toBeVisible();
    await expect(column(page).locator('li.pe__row .pe__name')).toHaveText([
      'Page details',
      'Slogan band',
      'Call to action',
    ]);
    expect((await sectionRow(sloganId))?.['sort_order']).toBe(10);
    expect((await sectionRow(ctaId))?.['sort_order']).toBe(20);

    // The eye: the hidden slogan band is shown.
    const eye = page.getByRole('switch', { name: 'Show Slogan band on the site' });
    await expect(eye).toHaveAttribute('aria-checked', 'false');
    await eye.click();
    await expect(eye).toHaveAttribute('aria-checked', 'true');
    expect((await sectionRow(sloganId))?.['visible']).toBe(true);

    // Rename the open section (the column's write moves its version: the form follows it).
    await page.getByRole('button', { name: 'Rename' }).click();
    const rename = page.getByRole('dialog', { name: 'Rename section' });
    await rename.getByLabel('Section name').fill(`Closing band ${MARK}`);
    await rename.getByRole('button', { name: 'Save name' }).click();
    await expect(rename).toBeHidden();
    await expect(pick(page, `Closing band ${MARK}`)).toBeVisible();
    expect((await sectionRow(ctaId))?.['label']).toBe(`Closing band ${MARK}`);

    // Its words: prefilled with the built-in copy; one heading saved, the only thing stored
    // with its highlight (the two are read together), after the move and the rename.
    const heading = page.locator('#f-content-heading-en');
    await expect(heading).toHaveValue(CTA_COPY.heading.en);
    await heading.fill(`Let us talk about it ${MARK}`);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.locator('.save-status[data-state="saved"]')).toBeVisible();
    const stored = (await sectionRow(ctaId))?.['content'] as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['accent', 'heading']);
    expect(stored['heading']).toEqual({
      en: `Let us talk about it ${MARK}`,
      ar: CTA_COPY.heading.ar,
    });

    // Leaving with words not saved asks first; Stay keeps them.
    await heading.fill(`Unsaved ${MARK}`);
    await pick(page, 'Slogan band').click();
    const ask = page.getByRole('dialog').filter({ hasText: 'Leave without saving?' });
    await ask.getByRole('button', { name: 'Stay' }).click();
    await expect(heading).toHaveValue(`Unsaved ${MARK}`);
    await expect(rowOf(page, `Closing band ${MARK}`)).toHaveAttribute('aria-current', 'true');

    // The language bar is the screen's: Both shows each half; a cleared Arabic is a gap,
    // counted in the bar, and Next gap takes focus to it.
    const bar = page.getByRole('group', { name: 'This page' });
    await bar
      .getByRole('group', { name: 'Editing language' })
      .getByRole('radio', { name: 'Both' })
      .check();
    const arabic = page.locator('#f-content-heading-ar');
    await expect(arabic).toBeVisible();
    await arabic.fill('');
    await expect(bar.getByRole('status')).toHaveText('Arabic missing: 1');
    await bar.getByRole('button', { name: 'Next gap' }).click();
    await expect(arabic).toBeFocused();
    await arabic.fill(CTA_COPY.heading.ar);
    await expect(bar.getByRole('status')).toHaveText('');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.locator('.save-status[data-state="saved"]')).toBeVisible();

    // History: the open section's saves, newest first, who and when.
    await bar.getByRole('button', { name: 'History' }).click();
    const history = page.getByRole('dialog', { name: `History: Closing band ${MARK}` });
    await expect(history.locator('.tl__i').first()).toContainText('Saved by');
    await page.keyboard.press('Escape');

    // The page details: its title saved through the pages route.
    await pick(page, 'Page details').click();
    await expect(page.getByRole('region', { name: 'Page details' })).toContainText(
      'No route of the site shows this page yet.',
    );
    await page.locator('#f-title-en').fill(`${TITLE.en} renamed`);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.locator('.save-status[data-state="saved"]')).toBeVisible();
    const { data } = await service().from('pages').select('title').eq('id', scratchId).single();
    expect((data as { title: { en: string } }).title.en).toBe(`${TITLE.en} renamed`);
  });

  test('Add section on About: refused kinds say why; one added hidden at the end, deleted', async ({
    page,
  }) => {
    await openEditor(page, aboutId);
    await column(page).getByRole('button', { name: 'Add section' }).click();
    const library = page.getByRole('dialog', { name: 'Add a section' });
    const hero = library.getByRole('button', { name: 'Hero' });
    await expect(hero).toHaveAttribute('aria-disabled', 'true');
    await expect(hero).toHaveAccessibleDescription(
      'This page already has its main heading, in Who we are.',
    );
    await expect(library.getByRole('button', { name: 'Leadership' })).toHaveAccessibleDescription(
      'This page has one already.',
    );
    const created = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/admin/sections' && r.request().method() === 'POST',
    );
    await library.getByRole('button', { name: 'Call to action' }).click();
    const answer = await created;
    expect(answer.status()).toBe(200);
    const body = (await answer.json()) as { data: { id: string } };
    added.push(body.data.id);
    await expect(library).toBeHidden();
    await expect(column(page).locator('li.pe__row .pe__name').last()).toHaveText('Call to action');
    const row = rowOf(page, 'Call to action');
    await expect(row).toHaveAttribute('aria-current', 'true');
    await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    const stored = await sectionRow(body.data.id);
    expect(stored).toMatchObject({ type: 'cta', visible: false, content: {}, sort_order: 50 });

    await page.getByRole('button', { name: 'Delete' }).click();
    const ask = page.getByRole('dialog').filter({ hasText: 'Delete the section' });
    await ask.getByRole('button', { name: 'Delete' }).click();
    await expect(rowOf(page, 'Call to action')).toHaveCount(0);
    expect(await sectionRow(body.data.id)).toBeNull();
  });
});

test.describe('as content_creator', () => {
  test.use({ storageState: authFile('content_creator') });

  test('edits sections, deletes none; reads the SEO drawer; clean at every width', async ({
    page,
  }) => {
    await openEditor(page, aboutId);
    const fields = page.getByRole('region', { name: 'Who we are' });
    await expect(fields.getByRole('button', { name: 'Rename' })).toBeVisible();
    await expect(fields.getByRole('button', { name: 'Delete' })).toHaveCount(0);
    await expect(fields).toContainText('Only an Admin can delete a section.');
    const bar = page.getByRole('group', { name: 'This page' });
    await expect(bar.getByRole('link', { name: 'Visibility' })).toHaveCount(0);
    await expectCleanAtWidths(page, 'the page editor (Content Creator)');

    await bar.getByRole('button', { name: 'SEO' }).click();
    const seo = page.getByRole('dialog', { name: 'SEO: About' });
    await expect(seo.getByRole('heading', { name: 'SEO: About' })).toBeVisible();
    await expect(seo.locator('button[type="submit"]')).toHaveCount(0);
    await expectCleanAtWidths(page, 'the SEO drawer, read only');
    await page.keyboard.press('Escape');
  });

  test('renames a section of the scratch page', async ({ page }) => {
    await openEditor(page, scratchId);
    await pick(page, 'Slogan band').click();
    await page.getByRole('button', { name: 'Rename' }).click();
    const rename = page.getByRole('dialog', { name: 'Rename section' });
    await rename.getByLabel('Section name').fill(`Slogan ${MARK}`);
    await rename.getByRole('button', { name: 'Save name' }).click();
    await expect(pick(page, `Slogan ${MARK}`)).toBeVisible();
    const { data } = await service()
      .from('page_sections')
      .select('label')
      .eq('page_id', scratchId)
      .eq('type', 'slogan')
      .single();
    expect((data as { label: string }).label).toBe(`Slogan ${MARK}`);
  });
});

test.describe('as seo', () => {
  test.use({ storageState: authFile('seo') });

  test('the SEO drawer only, clean at every width', async ({ page }) => {
    await open(page, `/admin/pages/${aboutId}`);
    await expect(page.getByRole('complementary', { name: 'Sections' })).toHaveCount(0);
    await expect(page.getByText('Your role changes this page’s SEO')).toBeVisible();
    await expectCleanAtWidths(page, 'the page editor (SEO)');
    await page.getByRole('button', { name: 'Edit SEO' }).click();
    const seo = page.getByRole('dialog', { name: 'SEO: About' });
    await expect(seo.getByRole('button', { name: 'Save SEO' })).toBeVisible();
    await expectCleanAtWidths(page, 'the SEO drawer (SEO)');
    await page.keyboard.press('Escape');
  });
});

for (const role of ['developer', 'sales'] as const) {
  test.describe(`as ${role}`, () => {
    test.use({ storageState: authFile(role) });

    test('the page editor is refused by the server', async ({ page }) => {
      const res = await page.goto(`/admin/pages/${aboutId}`);
      expect(res?.status()).toBe(403);
      await expect(page.locator('main .msg[data-kind="error"]').first()).toContainText(
        'Your role does not allow that.',
      );
      await expect(page.locator('astro-island[component-url*="AdminPageEditor"]')).toHaveCount(0);
    });
  });
}
