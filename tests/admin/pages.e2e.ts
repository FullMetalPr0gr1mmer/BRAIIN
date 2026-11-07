import { randomBytes } from 'node:crypto';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { TENANT_ID } from '../../scripts/gen-seeds.mjs';
import { ABOUT_WHO_COPY } from '@/lib/sections/copy/aboutWho';
import { CTA_COPY } from '@/lib/sections/copy/cta';
import { removeConfirm } from '@/components/admin/screens/pageEditor/model';
import { expectCleanAtWidths } from './collectionLayout';
import { discardDrafts, discardDraftsLike, publishOwn, systemClient } from './releaseSteps';
import { SKIP_REASON, authFile, releasesOn, staffEnv } from './staff';

/*
 * Pages and the page editor (Admin v2 E1), signed in, through the real Worker:
 *
 *   every width  the list, the editor on About, and the editor with each drawer (SEO, History)
 *                and dialog (Add a section, Rename section) open, as Admin; as a Content
 *                Creator with the SEO drawer read only; as SEO with its SEO drawer: zero axe
 *                WCAG 2.2 A/AA violations and no sideways scroll at 320, 390 and 1280 px;
 *   About        the sections in the site's order, the first open, its fields prefilled with
 *                the words the page shows (the built-in copy, nothing stored);
 *   a scratch    a page of this run's own (a draft custom page, so its route answers a 404 and
 *   page         no visitor sees any of this), with two sections made by the service role: Move down, the eye (and a refused
 *                one, whose reason stays after the list is read again), Rename, a
 *                heading's words saved as the only difference stored, the switch that asks
 *                before unsaved words are dropped, English / العربية / Both and "Arabic
 *                missing" with Next gap for the whole screen, History, and the page details;
 *   Add section  on About, as Admin: the kinds it may not take say why; with words not saved
 *                in the open section, opening the new one asks first; a call to action is
 *                added hidden at the end, then deleted (a hidden section renders nowhere);
 *   New page     (Admin v2 E11) as Admin: the dialog suggests an address from the English title,
 *                refuses a word the site already answers, makes a draft with its banner hero
 *                and opens its editor; the draft answers a 404 on the site, published it
 *                renders in both languages; a Content Creator has the button, SEO does not;
 *   per role     a Content Creator edits sections but deletes none ("hide it instead"); SEO
 *                gets the SEO drawer only; Developer and Sales are refused by the server.
 *
 * Every row this suite writes is its own (the scratch page, the added section), removed by the
 * service role afterwards whatever failed.
 *
 * Both modes (Admin v2 R14d). With releases on every write is a pending change: the column's
 * moves, eyes and renames, the section's words and the page details are read back as the
 * editor reads them (the API lays the pending change over live), never published (the scratch
 * page is a draft); switching sections saves the open words on the way instead of asking
 * (P-5), so "Stay" is releases off's alone; the bar has Publish… and the savebar island; the
 * new page and its banner are pending creates that this run publishes (`publishOwn`) before
 * the service role publishes the page itself; the added section is a pending create, and
 * removing it throws it away (removeConfirm's words). On About, release mode stages nothing
 * but that section (the unsaved-words check, which would stage the seeded "Who we are", is
 * releases off's: there the switch asks). The clean-up throws this run's unclaimed pending
 * changes away as the system before the rows go.
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
/** The page New page made (E11): its id, once the editor opened on it. */
let newPageId = '';
/** The page New page makes (E11), removed with its sections afterwards. */
const NEW_SLUG = `e2e-new-${MARK}`;
const NEW_TITLE = { en: `Made ${MARK}`, ar: `صفحة ${MARK}` };

const service = systemClient;

async function sectionRow(id: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await service()
    .from('page_sections')
    .select('id,type,label,content,visible,sort_order')
    .eq('id', id)
    .maybeSingle();
  expect(error).toBeNull();
  return data as Record<string, unknown> | null;
}

/**
 * A section as stored (releases off), or as the editor reads it (releases on: its pending change
 * laid over live, a pending create included); null when there is neither.
 */
async function sectionNow(page: Page, id: string): Promise<Record<string, unknown> | null> {
  if (!releasesOn()) return sectionRow(id);
  const res = await page.request.get(`/api/admin/sections/${id}`);
  if (res.status() === 404) return null;
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

/** A page row as stored (releases off), or as its editor reads it (releases on). */
async function pageNow(page: Page, id: string): Promise<Record<string, unknown>> {
  if (!releasesOn()) {
    const { data, error } = await service()
      .from('pages')
      .select('slug,title,status')
      .eq('id', id)
      .single();
    expect(error).toBeNull();
    return data as Record<string, unknown>;
  }
  const res = await page.request.get(`/api/admin/pages/${id}`);
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

/** A page's sections as the editor lists them (releases on: pending creates included). */
async function sectionsOf(page: Page, pageId: string): Promise<Record<string, unknown>[]> {
  const res = await page.request.get(`/api/admin/sections?page_id=${pageId}&limit=100`);
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { data: { rows: Record<string, unknown>[] } }).data.rows;
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
  // Releases on: this run's unclaimed pending changes first, as the system: the scratch page's
  // and its sections', the added section, and the new page with its banner (by its address and
  // by the page its banner names).
  const { data: scratch } = scratchId
    ? await svc.from('page_sections').select('id').eq('page_id', scratchId)
    : { data: [] };
  await discardDrafts([
    { entityType: 'page', entityIds: scratchId ? [scratchId] : [] },
    {
      entityType: 'page_section',
      entityIds: [...(scratch ?? []).map((r) => String(r.id)), ...added],
    },
  ]);
  await discardDraftsLike('page', 'payload->>slug', NEW_SLUG);
  if (newPageId) await discardDraftsLike('page_section', 'payload->>pageId', newPageId);
  if (added.length > 0) await svc.from('page_sections').delete().in('id', added);
  if (scratchId) await svc.from('pages').delete().eq('id', scratchId);
  // The New page test's page (its sections go with it: page_sections cascades), by its
  // address, so a run cut short after the create still cleans up.
  await svc.from('pages').delete().eq('tenant_id', TENANT_ID).eq('slug', NEW_SLUG);
});

async function open(page: Page, path: string) {
  const res = await page.goto(path, { waitUntil: 'networkidle' });
  expect(res?.status(), path).toBe(200);
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  await page.waitForLoadState('networkidle');
}

/** The sections column, once the island has read the sections. */
const column = (page: Page) => page.getByRole('complementary', { name: 'Sections' });
/**
 * A section's row in the column, by the exact text of its visible name (`.pe__name`). Not by the
 * open button's accessible name: its ", " separator is `.visually-hidden` (position: absolute),
 * and Chromium pads such a box with spaces when it computes the name ("Who we are , Who we
 * are"), so a `^name,` pattern never matched in CI.
 */
const rowOf = (page: Page, name: string) =>
  column(page)
    .locator('li.pe__row')
    .filter({ has: page.locator(`.pe__name:text-is(${JSON.stringify(name)})`) });
/** The row's open button (the one that selects the section). */
const pick = (page: Page, name: string) => rowOf(page, name).locator('button.pe__pick');

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
    // The template cards open the template editors (E3) for a role that edits pages.
    await expect(page.getByRole('link', { name: 'Service page' })).toHaveAttribute(
      'href',
      '/admin/pages/template/service',
    );
    await expect(page.getByRole('link', { name: 'Project page' })).toHaveAttribute(
      'href',
      '/admin/pages/template/project',
    );
    // The scratch page is a custom page (E11): it lives at its own address.
    await expect(
      cards.locator('li', { has: page.getByRole('link', { name: `Edit ${TITLE.en}` }) }),
    ).toContainText(`/${SLUG} · 2 sections`);
    await expect(page.getByRole('button', { name: 'New page' })).toBeVisible();
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
    // Releases off: nothing of releases. On: the bar's Publish… and the savebar island.
    const shown = releasesOn() ? 1 : 0;
    await expect(bar.getByRole('button', { name: 'Publish…' })).toHaveCount(shown);
    await expect(page.locator('astro-island[component-url*="AdminSavebar"]')).toHaveCount(shown);
    await expectCleanAtWidths(page, 'the page editor');
  });

  test('each drawer and dialog, clean at every width', async ({ page }) => {
    // Since E2 every check at 1280 px also runs axe over the public page in the preview
    // frame; nine width checks no longer fit the default 30 s.
    test.slow();
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
    expect((await sectionNow(page, sloganId))?.['sort_order']).toBe(10);
    expect((await sectionNow(page, ctaId))?.['sort_order']).toBe(20);

    // The eye: the hidden slogan band is shown.
    const eye = page.getByRole('switch', { name: 'Show Slogan band on the site' });
    await expect(eye).toHaveAttribute('aria-checked', 'false');
    await eye.click();
    await expect(eye).toHaveAttribute('aria-checked', 'true');
    expect((await sectionNow(page, sloganId))?.['visible']).toBe(true);

    // A refused eye (here a 409, as a colleague's save in between gives) says why, and the
    // reason stays on screen after the column reads the list again.
    const sloganPath = `/api/admin/sections/${sloganId}`;
    const refuse = (route: Route) =>
      route.request().method() === 'PATCH'
        ? route.fulfill({ status: 409, json: { ok: false, error: 'conflict' } })
        : route.fallback();
    const slogan = (url: URL) => url.pathname === sloganPath;
    await page.route(slogan, refuse);
    const reread = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/admin/sections' && r.request().method() === 'GET',
    );
    await eye.click();
    await reread;
    await expect(eye).toBeEnabled();
    await expect(column(page).getByRole('alert')).toHaveText(
      'Not changed. Someone else saved changes while you were editing. Reload to see their version.',
    );
    await expect(eye).toHaveAttribute('aria-checked', 'true');
    await page.unroute(slogan, refuse);
    expect((await sectionNow(page, sloganId))?.['visible']).toBe(true);

    // Rename the open section (the column's write moves its version: the form follows it).
    await page.getByRole('button', { name: 'Rename' }).click();
    const rename = page.getByRole('dialog', { name: 'Rename section' });
    await rename.getByLabel('Section name').fill(`Closing band ${MARK}`);
    await rename.getByRole('button', { name: 'Save name' }).click();
    await expect(rename).toBeHidden();
    await expect(pick(page, `Closing band ${MARK}`)).toBeVisible();
    expect((await sectionNow(page, ctaId))?.['label']).toBe(`Closing band ${MARK}`);

    // Its words: prefilled with the built-in copy; one heading saved, the only thing stored
    // with its highlight (the two are read together), after the move and the rename.
    const heading = page.locator('#f-content-heading-en');
    await expect(heading).toHaveValue(CTA_COPY.heading.en);
    await heading.fill(`Let us talk about it ${MARK}`);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.locator('.save-status[data-state="saved"]')).toBeVisible();
    const stored = (await sectionNow(page, ctaId))?.['content'] as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['accent', 'heading']);
    expect(stored['heading']).toEqual({
      en: `Let us talk about it ${MARK}`,
      ar: CTA_COPY.heading.ar,
    });

    // Leaving with words not saved asks first; Stay keeps them. Releases on, the switch saves
    // them on the way (P-5) and asks nothing; back on the section, they are there.
    await heading.fill(`Unsaved ${MARK}`);
    await pick(page, 'Slogan band').click();
    if (releasesOn()) {
      await expect(rowOf(page, 'Slogan band')).toHaveAttribute('aria-current', 'true');
      await expect(
        page.getByRole('dialog').filter({ hasText: 'Leave without saving?' }),
      ).toHaveCount(0);
      await expect
        .poll(
          async () =>
            ((await sectionNow(page, ctaId))?.['content'] as Record<string, unknown>)?.['heading'],
        )
        .toEqual({ en: `Unsaved ${MARK}`, ar: CTA_COPY.heading.ar });
      await pick(page, `Closing band ${MARK}`).click();
    } else {
      const ask = page.getByRole('dialog').filter({ hasText: 'Leave without saving?' });
      await ask.getByRole('button', { name: 'Stay' }).click();
    }
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
      `Address /${SLUG}, chosen when the page was made.`,
    );
    await page.locator('#f-title-en').fill(`${TITLE.en} renamed`);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.locator('.save-status[data-state="saved"]')).toBeVisible();
    const title = (await pageNow(page, scratchId))['title'] as { en: string };
    expect(title.en).toBe(`${TITLE.en} renamed`);
  });

  test('New page: a draft with its banner, its editor, then the page in both languages (E11)', async ({
    page,
  }) => {
    await open(page, '/admin/pages');
    await page.getByRole('button', { name: 'New page' }).click();
    const dialog = page.getByRole('dialog', { name: 'New page' });
    await expect(dialog).toBeVisible();
    await expectCleanAtWidths(page, 'the New page dialog');
    const address = dialog.getByLabel('Address', { exact: true });
    // The address follows the English title until it is typed in.
    await dialog.getByLabel('Title in English', { exact: true }).fill(NEW_TITLE.en);
    await expect(address).toHaveValue(`made-${MARK}`);
    await dialog.getByLabel('Title in Arabic', { exact: true }).fill(NEW_TITLE.ar);
    // A word the site already answers is refused on the address, before anything is sent.
    await address.fill('admin');
    await dialog.getByRole('button', { name: 'Make the page' }).click();
    await expect(dialog.getByRole('alert')).toHaveText(
      'The site already uses this address. Choose another one.',
    );
    await address.fill(NEW_SLUG);
    await expect(dialog).toContainText(`The page will be at /${NEW_SLUG} and /ar/${NEW_SLUG}.`);
    await dialog.getByRole('button', { name: 'Make the page' }).click();
    await page.waitForURL(/\/admin\/pages\/[0-9a-f-]{36}(\?|$)/);
    newPageId = /\/admin\/pages\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
    expect(newPageId).not.toBe('');

    // Stored: a draft at its address, with one shown hero whose headline is the title. (Releases
    // on: both are pending creates, read as the editor reads them.)
    const svc = service();
    const row = await pageNow(page, newPageId);
    expect({ slug: row['slug'], title: row['title'], status: row['status'] }).toEqual({
      slug: NEW_SLUG,
      title: NEW_TITLE,
      status: 'draft',
    });
    const listed = await sectionsOf(page, newPageId);
    expect(listed).toHaveLength(1);
    const hero = await sectionNow(page, String(listed[0]!['id']));
    expect({
      type: hero?.['type'],
      visible: hero?.['visible'],
      content: hero?.['content'],
    }).toEqual({ type: 'hero', visible: true, content: { headline: NEW_TITLE } });

    // The editor opened on it, and its page details say where it lives.
    await expect(column(page).locator('li.pe__row[aria-current="true"]')).toHaveCount(1);
    await pick(page, 'Page details').click();
    await expect(page.getByRole('region', { name: 'Page details' })).toContainText(
      `Address /${NEW_SLUG}, chosen when the page was made.`,
    );

    // A draft is not on the site.
    for (const path of [`/${NEW_SLUG}`, `/ar/${NEW_SLUG}`]) {
      const res = await page.request.get(path);
      expect(res.status(), path).toBe(404);
    }
    // Releases on: the page and its banner become live rows (a draft still) with this run's
    // own publish of the two.
    await publishOwn(
      page,
      [
        { entityType: 'page', entityIds: [newPageId] },
        { entityType: 'page_section', entityIds: [String(listed[0]!['id'])] },
      ],
      2,
    );
    // Published (by the service role, which the release guard lets through), it renders in
    // both languages with its title as its one heading.
    const published = await svc
      .from('pages')
      .update({ status: 'published', published_at: new Date().toISOString() })
      .eq('id', newPageId);
    expect(published.error).toBeNull();
    for (const [path, title] of [
      [`/${NEW_SLUG}`, NEW_TITLE.en],
      [`/ar/${NEW_SLUG}`, NEW_TITLE.ar],
    ] as const) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(200);
      await expect(page.locator('h1'), path).toHaveCount(1);
      await expect(page.locator('h1'), path).toHaveAttribute('aria-label', title);
    }
  });

  test('Add section on About: refused kinds say why; one added hidden at the end, deleted', async ({
    page,
  }) => {
    await openEditor(page, aboutId);
    // Words not saved in the open section (Who we are): opening the new one asks first. That
    // ask is releases off's (on, the switch saves them on the way, which would stage the seeded
    // section other specs open), so release mode adds with nothing typed.
    if (!releasesOn()) await page.locator('#f-content-heading-en').fill(`Unsaved ${MARK}`);
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
    if (!releasesOn()) {
      const ask = page.getByRole('dialog').filter({ hasText: 'Leave without saving?' });
      await ask.getByRole('button', { name: 'Leave without saving' }).click();
    }
    const row = rowOf(page, 'Call to action');
    await expect(row).toHaveAttribute('aria-current', 'true');
    await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    const stored = await sectionNow(page, body.data.id);
    expect(stored).toMatchObject({ type: 'cta', visible: false, content: {}, sort_order: 50 });

    // Releases on the section is a pending create, and removing it throws it away.
    const question = removeConfirm('Call to action', releasesOn());
    await page.getByRole('button', { name: 'Delete' }).click();
    const sure = page.getByRole('dialog').filter({ hasText: question.message });
    await sure.getByRole('button', { name: question.confirmLabel, exact: true }).click();
    await expect(rowOf(page, 'Call to action')).toHaveCount(0);
    expect(await sectionNow(page, body.data.id)).toBeNull();
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
    // A Content Creator makes pages too (pages.write, E11); the SEO drawer is checked below.
    await open(page, '/admin/pages');
    await expect(page.getByRole('button', { name: 'New page' })).toBeVisible();
    await openEditor(page, aboutId);

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
      .select('id,label')
      .eq('page_id', scratchId)
      .eq('type', 'slogan')
      .single();
    // Releases on: the name is a pending change, read as the editor reads it.
    const slogan = await sectionNow(page, String((data as { id: string }).id));
    expect(slogan?.['label']).toBe(`Slogan ${MARK}`);
  });
});

test.describe('as seo', () => {
  test.use({ storageState: authFile('seo') });

  test('the SEO drawer only, clean at every width', async ({ page }) => {
    // SEO reads the pages list but makes no page (no pages.write, E11).
    await open(page, '/admin/pages');
    await expect(page.getByRole('button', { name: 'New page' })).toHaveCount(0);
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
