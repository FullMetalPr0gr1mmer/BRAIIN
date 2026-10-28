import { randomBytes } from 'node:crypto';
import { expect, test, type Frame, type Page, type Route } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { TENANT_ID } from '../../scripts/gen-seeds.mjs';
import { expectCleanAtWidths } from './collectionLayout';
import { SKIP_REASON, authFile, staffEnv } from './staff';

/*
 * The page editor's live preview column (Admin v2 E2), signed in, through the real Worker,
 * releases off, so the preview is the live page (R9):
 *
 *   Admin          About's preview in the third column: the open section outlined, another
 *                  section opened in the column followed, a click on a section in the preview
 *                  opening it in the column, Phone, Arabic from the editor's language and back
 *                  from the column's own switch; the editor's response frames its own origin
 *                  only and the preview's may be framed by it only; zero CSP violations, page
 *                  or console errors in the editor and in the frame;
 *   a save         the open section's Save (routed: nothing is written) reloads the preview,
 *                  which points at the open section again;
 *   every width    320 and 390 with Preview chosen in the Edit | Preview switch, and 1280 with
 *                  three columns: zero axe WCAG 2.2 A/AA violations (the frame included) and no
 *                  sideways scroll;
 *   per role       a Content Creator gets the preview too; SEO opens the editor's SEO card only,
 *                  so no preview; Developer and Sales are refused by the server.
 *
 * This suite writes nothing: About is the seed's, and the one save is answered by the test.
 */

test.skip(!staffEnv(), SKIP_REASON);
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const MARK = randomBytes(4).toString('hex');
let aboutId = '';
/** About's section ids, by type (the seed: aboutWho, leadership, statistics, social). */
const ids: Record<string, string> = {};

function service() {
  const env = staffEnv()!;
  return createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
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
  const sections = await svc
    .from('page_sections')
    .select('id,type')
    .eq('tenant_id', TENANT_ID)
    .eq('page_id', aboutId);
  expect(sections.error).toBeNull();
  for (const row of (sections.data ?? []) as { id: string; type: string }[]) ids[row.type] = row.id;
  expect(Object.keys(ids).sort()).toEqual(['aboutWho', 'leadership', 'social', 'statistics']);
});

/** Page and console errors, and CSP violations in the editor and in every frame. */
async function watch(page: Page): Promise<() => Promise<string[]>> {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const where = message.location().url;
    problems.push(`console: ${message.text()}${where ? ` (${where})` : ''}`);
  });
  // Runs in the page and in every frame it attaches (the preview included).
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      w.__csp.push(`${event.violatedDirective} ${event.blockedURI || 'inline'}`);
    });
  });
  return async () => {
    const csp: string[] = [];
    for (const frame of page.frames()) {
      const found = await frame
        .evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])
        .catch(() => [] as string[]);
      csp.push(...found.map((v) => `csp (${frame.url()}): ${v}`));
    }
    return [...problems, ...csp];
  };
}

async function openEditor(page: Page, id: string) {
  const res = await page.goto(`/admin/pages/${id}`, { waitUntil: 'networkidle' });
  expect(res?.status()).toBe(200);
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  await page.waitForLoadState('networkidle');
  await expect(column(page).locator('li.pe__row[aria-current="true"]')).toHaveCount(1);
}

const column = (page: Page) => page.getByRole('complementary', { name: 'Sections' });
/** A row of the sections column, by the exact text of its name (see pages.e2e.ts). */
const rowOf = (page: Page, name: string) =>
  column(page)
    .locator('li.pe__row')
    .filter({ has: page.locator(`.pe__name:text-is(${JSON.stringify(name)})`) });
const pick = (page: Page, name: string) => rowOf(page, name).locator('button.pe__pick');

const previewRegion = (page: Page) =>
  page.getByRole('region', { name: 'Live preview', exact: true });
const FRAME = 'iframe[title="Live preview of About"]';
/** A section of About inside the preview, by its type. */
const inPreview = (page: Page, type: string) =>
  page.frameLocator(FRAME).locator(`[data-pv-section="${ids[type]}"]`);
const OUTLINED = /(^|\s)pv-highlight(\s|$)/;

/** The preview's frame, once it shows About in English. */
async function previewFrame(page: Page): Promise<Frame> {
  await expect
    .poll(() => page.frames().some((f) => new URL(f.url()).pathname === '/admin/preview/about'))
    .toBe(true);
  return page.frames().find((f) => new URL(f.url()).pathname === '/admin/preview/about')!;
}

test.describe('as admin', () => {
  test.use({ storageState: authFile('admin') });

  test('the preview follows the open section, both ways, at a device width and in Arabic', async ({
    page,
  }) => {
    // The framing rules (R9): the editor frames its own origin; the preview may be framed by it.
    const editorCsp = (await page.request.get(`/admin/pages/${aboutId}`)).headers()[
      'content-security-policy'
    ];
    expect(editorCsp).toMatch(/frame-src 'self' /);
    const shown = await page.request.get('/admin/preview/about', { maxRedirects: 0 });
    expect(shown.status()).toBe(200);
    expect(shown.headers()['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(shown.headers()['x-frame-options']).toBe('SAMEORIGIN');

    const live = await watch(page);
    await openEditor(page, aboutId);
    const preview = previewRegion(page);
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('This is the page as visitors see it.');
    const frame = preview.locator('iframe');
    await expect(frame).toHaveAttribute('src', '/admin/preview/about');
    await expect(frame).toHaveAttribute('title', 'Live preview of About');

    // The open section (the first, Who we are) is outlined in the preview.
    await expect(rowOf(page, 'Who we are')).toHaveAttribute('aria-current', 'true');
    await expect(inPreview(page, 'aboutWho')).toHaveClass(OUTLINED);

    // Another section opened in the column: the preview follows.
    await pick(page, 'Leadership').click();
    await expect(inPreview(page, 'leadership')).toHaveClass(OUTLINED);
    await expect(inPreview(page, 'aboutWho')).not.toHaveClass(OUTLINED);

    // A click on a section in the preview opens it in the column.
    await inPreview(page, 'statistics').dispatchEvent('click');
    await expect(rowOf(page, 'Numbers')).toHaveAttribute('aria-current', 'true');
    await expect(page.getByRole('region', { name: 'Numbers', exact: true })).toBeVisible();
    await expect(inPreview(page, 'statistics')).toHaveClass(OUTLINED);

    // Phone: the page at 390 px, scaled into the column (never wider than it).
    await preview
      .getByRole('group', { name: 'Preview size' })
      .getByRole('radio', { name: 'Phone', exact: true })
      .check();
    await expect.poll(() => frame.evaluate((el) => (el as HTMLElement).style.width)).toBe('390px');
    const fits = await page.evaluate(() => {
      const area = document.querySelector('.pv-col__area')!.getBoundingClientRect();
      const box = document.querySelector('.pv-col__fit')!.getBoundingClientRect();
      return box.width > 0 && box.width <= area.width && box.height <= area.height;
    });
    expect(fits).toBe(true);

    // Arabic: the editor's language swaps the frame's address; the open section is outlined
    // there too. Then the column's own switch takes it back to English.
    await page
      .getByRole('group', { name: 'This page' })
      .getByRole('group', { name: 'Editing language' })
      .getByRole('radio', { name: 'العربية' })
      .check();
    await expect(frame).toHaveAttribute('src', '/admin/preview/ar/about');
    await expect(page.frameLocator(FRAME).locator('html')).toHaveAttribute('lang', 'ar');
    await expect(inPreview(page, 'statistics')).toHaveClass(OUTLINED);
    await preview
      .getByRole('group', { name: 'Preview language' })
      .getByRole('radio', { name: 'English' })
      .check();
    await expect(frame).toHaveAttribute('src', '/admin/preview/about');
    await expect(inPreview(page, 'statistics')).toHaveClass(OUTLINED);

    expect(await live(), 'page errors, console errors and CSP violations').toEqual([]);
  });

  test('a save reloads the preview, which points at the open section again', async ({ page }) => {
    await openEditor(page, aboutId);
    await expect(inPreview(page, 'aboutWho')).toHaveClass(OUTLINED);
    const frame = await previewFrame(page);
    await frame.evaluate(() => {
      (window as unknown as { __e2: boolean }).__e2 = true;
    });

    // The save is answered here (its row, one version on), so About is never written.
    const path = `/api/admin/sections/${ids['aboutWho']}`;
    const current = (await (await page.request.get(path)).json()) as {
      data: Record<string, unknown>;
    };
    const version = Number(current.data['version']);
    const answer = { ...current, data: { ...current.data, version: version + 1 } };
    const fake = (route: Route) =>
      route.request().method() === 'PATCH'
        ? route.fulfill({ status: 200, json: answer })
        : route.fallback();
    const match = (url: URL) => url.pathname === path;
    await page.route(match, fake);
    await page.locator('#f-content-heading-en').fill(`Preview ${MARK}`);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.locator('.save-status[data-state="saved"]')).toBeVisible();

    // The frame's document is a new one (the mark is gone), and it outlines Who we are again.
    await expect
      .poll(() =>
        frame
          .evaluate(() => (window as unknown as { __e2?: boolean }).__e2 === true)
          .catch(() => 'navigating'),
      )
      .toBe(false);
    await expect(inPreview(page, 'aboutWho')).toHaveClass(OUTLINED);
    await page.unroute(match, fake);

    const { data, error } = await service()
      .from('page_sections')
      .select('version')
      .eq('id', ids['aboutWho']!)
      .single();
    expect(error).toBeNull();
    expect((data as { version: number }).version).toBe(version);
  });

  test('narrow screens: Edit | Preview; clean at 320, 390 and 1280 with the preview on', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await openEditor(page, aboutId);
    // The fields first; the preview is not loaded until it is asked for.
    await expect(page.locator('form.editor')).toBeVisible();
    await expect(previewRegion(page)).toBeHidden();
    await expect(page.locator(FRAME)).toHaveCount(0);

    await page
      .getByRole('group', { name: 'Show', exact: true })
      .getByRole('radio', { name: 'Preview' })
      .check();
    await expect(previewRegion(page)).toBeVisible();
    await expect(page.locator('form.editor')).toBeHidden();
    await expect(inPreview(page, 'aboutWho')).toHaveClass(OUTLINED);
    await page.waitForLoadState('networkidle');
    await expectCleanAtWidths(page, 'the page editor with its live preview');

    // Back to Edit: the fields again, the preview kept but hidden.
    await page.setViewportSize({ width: 390, height: 900 });
    await page
      .getByRole('group', { name: 'Show', exact: true })
      .getByRole('radio', { name: 'Edit' })
      .check();
    await expect(page.locator('form.editor')).toBeVisible();
    await expect(previewRegion(page)).toBeHidden();
  });
});

test.describe('as content_creator', () => {
  test.use({ storageState: authFile('content_creator') });

  test('the preview, following the open section', async ({ page }) => {
    const live = await watch(page);
    await openEditor(page, aboutId);
    await expect(previewRegion(page)).toBeVisible();
    await expect(inPreview(page, 'aboutWho')).toHaveClass(OUTLINED);
    await pick(page, 'Social links').click();
    await expect(inPreview(page, 'social')).toHaveClass(OUTLINED);
    expect(await live(), 'page errors, console errors and CSP violations').toEqual([]);
  });
});

test.describe('as seo', () => {
  test.use({ storageState: authFile('seo') });

  test('the SEO card only: no preview column', async ({ page }) => {
    const res = await page.goto(`/admin/pages/${aboutId}`, { waitUntil: 'networkidle' });
    expect(res?.status()).toBe(200);
    await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
    await expect(page.getByText('Your role changes this page’s SEO')).toBeVisible();
    await expect(previewRegion(page)).toHaveCount(0);
    await expect(page.locator('iframe')).toHaveCount(0);
  });
});

for (const role of ['developer', 'sales'] as const) {
  test.describe(`as ${role}`, () => {
    test.use({ storageState: authFile(role) });

    test('no editor, so no preview: the server refuses it', async ({ page }) => {
      const res = await page.goto(`/admin/pages/${aboutId}`);
      expect(res?.status()).toBe(403);
      await expect(page.locator('iframe')).toHaveCount(0);
    });
  });
}
