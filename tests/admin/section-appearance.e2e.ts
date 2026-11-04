import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { TENANT_ID } from '../../scripts/gen-seeds.mjs';
import { expectCleanAtWidths } from './collectionLayout';
import { RELEASES_OFF_ONLY, SKIP_REASON, authFile, releasesOn, staffEnv } from './staff';

/*
 * Section appearance (Admin v2 E9), stored and served, through the real Worker and the seeded
 * local database, releases off. The service role makes a published custom page of the run's own
 * (a banner hero, a Text block, a call to action and a second Text block, each named) and
 * removes it afterwards whatever failed; the project runs after the public and the admin specs
 * (playwright.config.ts `blocks`), because a published page is in the sitemap and the link
 * picker every other spec may read.
 *
 *   the editor    as Admin: the second Text block's Appearance card (background, spacing,
 *                 reveal, anchor) saved with the section (one PATCH, one version) and stored;
 *                 the header names the stored anchor; the live preview (E2) draws the choices;
 *                 the first Text block is in the page's opening and says its reveal waits; a
 *                 duplicate anchor on the page is refused on the field; a name the site uses is
 *                 refused before saving; changing a saved anchor warns; the call to action says
 *                 what it keeps; clean at every width (axe, no sideways scroll);
 *   the link      the link picker's answer offers `/<page>#<anchor>`;
 *   the roles     a Content Creator saves an appearance; SEO and Developer are refused by the
 *                 server (403), whatever the editor shows;
 *   served HTML   /<page> and /ar/<page>: the attributes on the second Text block's own first
 *                 element, none on the first one's reveal (the opening), no style attribute.
 */

test.skip(!staffEnv(), SKIP_REASON);
test.skip(releasesOn(), RELEASES_OFF_ONLY);
test.describe.configure({ mode: 'serial' });

const MARK = randomBytes(4).toString('hex');
const SLUG = `e9-look-${MARK}`;
const TITLE = { en: `E9 look ${MARK}`, ar: `مظهر ${MARK}` };
const ANCHOR = `story-${MARK}`;
const NAMES = {
  hero: 'E9 banner',
  first: 'E9 first block',
  cta: 'E9 call',
  second: 'E9 story block',
} as const;
type Key = keyof typeof NAMES;

const para = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
const block = (en: string, ar: string) => ({
  heading: { en, ar },
  body: { en: { type: 'doc', content: [para(en)] }, ar: { type: 'doc', content: [para(ar)] } },
});

let pageId = '';
const ids: Record<Key, string> = { hero: '', first: '', cta: '', second: '' };

function service() {
  const env = staffEnv()!;
  return createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** The CSRF double-submit token the layout hands the page, for a hand-made mutation. */
async function csrfOf(page: Page): Promise<string> {
  const token = await page.locator('meta[name="csrf-token"]').getAttribute('content');
  expect(token, 'the admin layout carries a CSRF token').toBeTruthy();
  return token!;
}

async function stored(id: string) {
  const { data, error } = await service()
    .from('page_sections')
    .select('background,spacing,reveal,anchor,version')
    .eq('id', id)
    .single();
  expect(error).toBeNull();
  return data as {
    background: string | null;
    spacing: string | null;
    reveal: string | null;
    anchor: string | null;
    version: number;
  };
}

test.beforeAll(async () => {
  if (!staffEnv() || releasesOn()) return;
  const svc = service();
  const made = await svc
    .from('pages')
    .insert({ tenant_id: TENANT_ID, slug: SLUG, title: TITLE, status: 'published' })
    .select('id')
    .single();
  expect(made.error).toBeNull();
  pageId = String((made.data as { id: string }).id);
  const rows = [
    { key: 'hero', type: 'hero', content: {} },
    { key: 'first', type: 'textBlock', content: block(`First ${MARK}`, `أول ${MARK}`) },
    { key: 'cta', type: 'cta', content: {} },
    { key: 'second', type: 'textBlock', content: block(`Story ${MARK}`, `قصة ${MARK}`) },
  ] as const;
  const inserted = await svc
    .from('page_sections')
    .insert(
      rows.map((row, i) => ({
        tenant_id: TENANT_ID,
        page_id: pageId,
        type: row.type,
        content: row.content,
        label: NAMES[row.key],
        visible: true,
        sort_order: 10 * (i + 1),
      })),
    )
    .select('id,label');
  expect(inserted.error).toBeNull();
  for (const row of (inserted.data ?? []) as { id: string; label: string }[]) {
    const key = (Object.keys(NAMES) as Key[]).find((k) => NAMES[k] === row.label)!;
    ids[key] = row.id;
  }
  expect(Object.values(ids).every(Boolean)).toBe(true);
});

test.afterAll(async () => {
  if (!staffEnv() || releasesOn() || !pageId) return;
  // The page's sections go with it (page_sections.page_id cascades).
  await service().from('pages').delete().eq('id', pageId);
});

const column = (page: Page) => page.getByRole('complementary', { name: 'Sections' });
const rowOf = (page: Page, name: string) =>
  column(page)
    .locator('li.pe__row')
    .filter({ has: page.locator(`.pe__name:text-is(${JSON.stringify(name)})`) });

async function openEditor(page: Page) {
  const res = await page.goto(`/admin/pages/${pageId}`, { waitUntil: 'load' });
  expect(res?.status()).toBe(200);
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  await expect(column(page).locator('li.pe__row[aria-current="true"]')).toHaveCount(1);
}

async function openSection(page: Page, key: Key) {
  await rowOf(page, NAMES[key]).locator('button.pe__pick').click();
  await expect(rowOf(page, NAMES[key])).toHaveAttribute('aria-current', 'true');
  const panel = page.getByRole('region', { name: NAMES[key] });
  await expect(panel.getByRole('region', { name: 'Appearance' })).toBeVisible();
  return panel;
}

async function saveSection(page: Page, key: Key) {
  const saved = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/admin/sections/${ids[key]}` &&
      r.request().method() === 'PATCH',
  );
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  return saved;
}

test.describe('the page editor, as admin', () => {
  test.use({ storageState: authFile('admin'), contextOptions: { reducedMotion: 'reduce' } });

  test('the Appearance card saves with the section, and the preview draws it', async ({ page }) => {
    // The width checks at 1280 px also run axe over the public page in the preview frame.
    test.slow();
    await openEditor(page);
    const panel = await openSection(page, 'second');
    const card = panel.getByRole('region', { name: 'Appearance' });
    await expect(card.locator('#f-background option')).toHaveText([
      'Its own (white)',
      'Light grey',
      'Black',
      'Primary colour',
    ]);
    await card.locator('#f-background').selectOption('ink');
    await card.locator('#f-spacing').selectOption('roomy');
    await card.locator('#f-reveal').selectOption('fade');
    await card.locator('#f-anchor').fill(ANCHOR);
    // The second Text block is fourth on the page: its reveal plays, so nothing says it waits.
    await expect(card).not.toContainText('among the first two');
    expect((await saveSection(page, 'second')).status()).toBe(200);
    await expect(page.locator('.save-status[data-state="saved"]')).toBeVisible();
    expect(await stored(ids.second)).toMatchObject({
      background: 'ink',
      spacing: 'roomy',
      reveal: 'fade',
      anchor: ANCHOR,
    });
    // The header follows the stored anchor.
    await expect(panel).toContainText(`anchor #${ANCHOR}`);
    // The live preview (E2) reloads after the save and draws the choices on the section.
    const preview = page
      .frameLocator(`iframe[title="Live preview of ${TITLE.en}"]`)
      .locator(`[data-pv-section="${ids.second}"]`);
    await expect(preview).toHaveAttribute('data-bg', 'ink', { timeout: 20_000 });
    await expect(preview).toHaveAttribute('id', ANCHOR);
    await expect(preview).toHaveAttribute('data-reveal', 'fade');
    await expectCleanAtWidths(page, 'the Appearance card');
  });

  test('the first Text block opens the page: its reveal waits, and it says so', async ({
    page,
  }) => {
    await openEditor(page);
    const card = (await openSection(page, 'first')).getByRole('region', { name: 'Appearance' });
    await expect(card).toContainText('among the first two the page shows');
    await card.locator('#f-reveal').selectOption('rise');
    await expect(card).toContainText(
      'The reveal you chose waits until the section is further down.',
    );
    expect((await saveSection(page, 'first')).status()).toBe(200);
    expect((await stored(ids.first)).reveal).toBe('rise');
  });

  test('an anchor another section of the page holds is refused on the field', async ({ page }) => {
    await openEditor(page);
    const panel = await openSection(page, 'cta');
    const card = panel.getByRole('region', { name: 'Appearance' });
    // A call to action keeps its own background and spacing, and says so.
    await expect(card).toContainText('Background and spacing: this kind of section keeps its own');
    await expect(card.locator('#f-background')).toHaveCount(0);
    // A name the site itself uses is refused before saving.
    await card.locator('#f-anchor').fill('main');
    await expect(card).toContainText('#main is used by the site itself.');
    await card.locator('#f-anchor').fill(ANCHOR);
    const res = await saveSection(page, 'cta');
    expect(res.status()).toBe(422);
    await expect(
      card.getByText('Another section of this page already has this anchor. Choose another.'),
    ).toBeVisible();
    expect((await stored(ids.cta)).anchor).toBeNull();
  });

  test('changing a saved anchor warns that links to the old one stop working', async ({ page }) => {
    await openEditor(page);
    const card = (await openSection(page, 'second')).getByRole('region', { name: 'Appearance' });
    await expect(card.locator('#f-anchor')).toHaveValue(ANCHOR);
    await card.locator('#f-anchor').fill(`${ANCHOR}-2`);
    await expect(card).toContainText(`Links to #${ANCHOR} will stop working once you save`);
    // Left unsaved.
    expect((await stored(ids.second)).anchor).toBe(ANCHOR);
  });

  test('the link picker offers the stored anchor', async ({ page }) => {
    await page.goto('/admin', { waitUntil: 'load' });
    const res = await page.request.get('/api/admin/linkables');
    expect(res.status()).toBe(200);
    // The admin envelope: { ok, data } (src/lib/admin/route.ts).
    const body = (await res.json()) as { data?: { links?: { href: string; group: string }[] } };
    expect(body.data?.links).toContainEqual(
      expect.objectContaining({ href: `/${SLUG}#${ANCHOR}`, group: 'anchor' }),
    );
  });
});

test.describe('who may change it (both server layers)', () => {
  test.describe('as content_creator', () => {
    test.use({ storageState: authFile('content_creator') });
    test('a Content Creator saves an appearance (pages.write)', async ({ page }) => {
      await page.goto('/admin', { waitUntil: 'load' });
      const { version } = await stored(ids.cta);
      const res = await page.request.patch(`/api/admin/sections/${ids.cta}`, {
        headers: { 'x-csrf-token': await csrfOf(page), origin: new URL(page.url()).origin },
        data: { version, reveal: 'rise' },
      });
      expect(res.status()).toBe(200);
      expect((await stored(ids.cta)).reveal).toBe('rise');
    });
  });

  for (const role of ['seo', 'developer'] as const) {
    test.describe(`as ${role}`, () => {
      test.use({ storageState: authFile(role) });
      test(`${role} is refused by the server`, async ({ page }) => {
        await page.goto('/admin', { waitUntil: 'load' });
        const { version } = await stored(ids.cta);
        const res = await page.request.patch(`/api/admin/sections/${ids.cta}`, {
          headers: { 'x-csrf-token': await csrfOf(page), origin: new URL(page.url()).origin },
          data: { version, reveal: 'fade' },
        });
        expect(res.status(), `PATCH as ${role}`).toBe(403);
        expect((await stored(ids.cta)).reveal).toBe('rise');
      });
    });
  }
});

test.describe('the served page', () => {
  for (const path of [`/${SLUG}`, `/ar/${SLUG}`]) {
    test(`${path}: the attributes on the second Text block, none of the opening's reveal`, async ({
      request,
    }) => {
      const res = await request.get(path);
      expect(res.status()).toBe(200);
      const html = await res.text();
      const openings = html.match(/<section\b[^>]*class="blk-text"[^>]*>/g) ?? [];
      expect(openings).toHaveLength(2);
      // The first Text block opens the page (second after its banner): no reveal there.
      expect(openings[0]).toBe('<section class="blk-text">');
      expect(openings[1]).toBe(
        `<section id="${ANCHOR}" data-bg="ink" data-space="roomy" data-reveal="fade" class="blk-text">`,
      );
      // The call to action takes a reveal (third on the page).
      expect(html).toMatch(/<section data-reveal="rise" class="lead-band klein-band"/);
      expect(html).not.toMatch(/<section[^>]*\sstyle=/);
    });
  }
});
