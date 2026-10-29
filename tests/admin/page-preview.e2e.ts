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
 *   a save         the open section's Save, and the eye (both routed: nothing is written),
 *                  reload the preview, which points at the open section again;
 *   1280           the column sticks below the topbar, and a 20 px default font does not push
 *                  the three columns past the window;
 *   every width    320 and 390 with Preview chosen in the Edit | Preview switch, and 1280 with
 *                  three columns: zero axe WCAG 2.2 A/AA violations (the frame included) and no
 *                  sideways scroll;
 *   while hidden   at 390 with Edit chosen: a save, another section opened and the editor's
 *                  language wait for Preview (no reload, no request for the Arabic page), then
 *                  the preview reloads, jumps to the open section, and loads the Arabic page;
 *   per role       a Content Creator gets the preview too; SEO opens the editor's SEO card only,
 *                  so no preview; Developer and Sales are refused by the server.
 *
 * This suite writes nothing: About is the seed's, and every save is answered by the test.
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
  // The visible ones only: pages.e2e.ts, in parallel, adds a hidden Call to action to About for
  // a while (and leaves it there until its afterAll when a step of it fails).
  const sections = await svc
    .from('page_sections')
    .select('id,type')
    .eq('tenant_id', TENANT_ID)
    .eq('page_id', aboutId)
    .eq('visible', true);
  expect(sections.error).toBeNull();
  for (const row of (sections.data ?? []) as { id: string; type: string }[]) ids[row.type] = row.id;
  expect(Object.keys(ids)).toEqual(
    expect.arrayContaining(['aboutWho', 'leadership', 'social', 'statistics']),
  );
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

/** Requests still open and the preview frame's navigations, so a wait that fails says why. */
function watchNetwork(page: Page) {
  const net = { open: new Map<object, string>(), frameLoads: 0 };
  page.on('request', (r) => net.open.set(r, `${r.method()} ${new URL(r.url()).pathname}`));
  page.on('requestfinished', (r) => net.open.delete(r));
  page.on('requestfailed', (r) => net.open.delete(r));
  page.on('framenavigated', (f) => {
    if (f !== page.mainFrame()) net.frameLoads += 1;
  });
  return net;
}

/** No request open for half a second, or a failure naming what kept the network busy. */
async function settled(page: Page, net: ReturnType<typeof watchNetwork>) {
  const until = Date.now() + 15_000;
  let quietSince = 0;
  while (Date.now() < until) {
    if (net.open.size === 0) {
      if (quietSince === 0) quietSince = Date.now();
      if (Date.now() - quietSince >= 500) return;
    } else quietSince = 0;
    await page.waitForTimeout(100);
  }
  throw new Error(
    `the network never went quiet: ${net.frameLoads} preview loads; open: ${[...net.open.values()].join(', ')}`,
  );
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

/**
 * Answers the section's PATCH here (its row, `patch` applied and one version on), so About is
 * never written; the stored version, read before, is checked unchanged by `done`.
 */
async function routeSave(page: Page, type: string, patch: Record<string, unknown> = {}) {
  const path = `/api/admin/sections/${ids[type]}`;
  const current = (await (await page.request.get(path)).json()) as {
    data: Record<string, unknown>;
  };
  const version = Number(current.data['version']);
  const answer = { ...current, data: { ...current.data, ...patch, version: version + 1 } };
  const fake = (route: Route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({ status: 200, json: answer })
      : route.fallback();
  const match = (url: URL) => url.pathname === path;
  await page.route(match, fake);
  return async () => {
    await page.unroute(match, fake);
    const { data, error } = await service()
      .from('page_sections')
      .select('version')
      .eq('id', ids[type]!)
      .single();
    expect(error).toBeNull();
    expect((data as { version: number }).version).toBe(version);
  };
}

/** Marks the frame's document, so a reload (a new document) is seen. */
const mark = (frame: Frame) =>
  frame.evaluate(() => {
    (window as unknown as { __e2: boolean }).__e2 = true;
  });
/** Whether the marked document is still the one shown ('navigating' while it is replaced). */
const marked = (frame: Frame) =>
  frame
    .evaluate(() => (window as unknown as { __e2?: boolean }).__e2 === true)
    .catch(() => 'navigating');

/** Whether a section of About is inside the frame's own viewport. */
const inView = (frame: Frame, type: string) =>
  frame
    .evaluate((id) => {
      const el = document.querySelector(`[data-pv-section="${id}"]`);
      if (!el) return 'missing';
      const box = el.getBoundingClientRect();
      return box.top < window.innerHeight && box.bottom > 0;
    }, ids[type]!)
    .catch(() => 'navigating');

const showView = (page: Page, name: 'Edit' | 'Preview') =>
  page.getByRole('group', { name: 'Show', exact: true }).getByRole('radio', { name }).check();

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
    await mark(frame);

    // The save is answered here (its row, one version on), so About is never written.
    const done = await routeSave(page, 'aboutWho');
    await page.locator('#f-content-heading-en').fill(`Preview ${MARK}`);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.locator('.save-status[data-state="saved"]')).toBeVisible();

    // The frame's document is a new one (the mark is gone), and it outlines Who we are again.
    await expect.poll(() => marked(frame)).toBe(false);
    await expect(inPreview(page, 'aboutWho')).toHaveClass(OUTLINED);
    await done();
  });

  test('the eye reloads the preview too', async ({ page }) => {
    await openEditor(page, aboutId);
    await expect(inPreview(page, 'aboutWho')).toHaveClass(OUTLINED);
    const frame = await previewFrame(page);
    await mark(frame);

    // Social links hidden: the PATCH answered here with the row hidden, one version on.
    const done = await routeSave(page, 'social', { visible: false });
    const eye = page.getByRole('switch', { name: 'Show Social links on the site' });
    await expect(eye).toHaveAttribute('aria-checked', 'true');
    await eye.click();
    await expect(eye).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => marked(frame)).toBe(false);
    await expect(inPreview(page, 'aboutWho')).toHaveClass(OUTLINED);
    await done();
  });

  test('1280: the column sticks below the topbar; a 20 px default font fits', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openEditor(page, aboutId);
    await expect(previewRegion(page)).toBeVisible();
    // The column sticks below the sticky topbar, never under it (whatever the page's height,
    // so no scroll is needed to read it).
    const stick = await page.evaluate(() => ({
      top: parseFloat(getComputedStyle(document.querySelector('.pe__preview')!).top),
      bar: document.querySelector('.admin-main > .admin-topbar')!.getBoundingClientRect().height,
    }));
    expect(stick.bar).toBeGreaterThan(0);
    expect(stick.top).toBeGreaterThanOrEqual(stick.bar);
    // Chrome's "Large" font (a 20 px root): the three tracks still fit the editor's width.
    const fit = await page.evaluate(() => {
      const root = document.documentElement;
      root.style.fontSize = '20px';
      const cols = document.querySelector<HTMLElement>('.pe__cols')!;
      const style = getComputedStyle(cols);
      const tracks = style.gridTemplateColumns.split(' ').map(parseFloat);
      const used = tracks.reduce((sum, n) => sum + n, 0) + 2 * parseFloat(style.columnGap);
      const out = { tracks: tracks.length, used, width: cols.clientWidth };
      root.style.fontSize = '';
      return out;
    });
    expect(fit.tracks).toBe(3);
    expect(fit.used).toBeLessThanOrEqual(fit.width + 0.5);
  });

  test('narrow screens: Edit | Preview; clean at 320, 390 and 1280 with the preview on', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    const net = watchNetwork(page);
    await openEditor(page, aboutId);
    // The fields first; the preview is not loaded until it is asked for.
    await expect(page.locator('form.editor')).toBeVisible();
    await expect(previewRegion(page)).toBeHidden();
    await expect(page.locator(FRAME)).toHaveCount(0);

    await showView(page, 'Preview');
    await expect(previewRegion(page)).toBeVisible();
    await expect(page.locator('form.editor')).toBeHidden();
    await expect(inPreview(page, 'aboutWho')).toHaveClass(OUTLINED);
    await settled(page, net);
    await expectCleanAtWidths(page, 'the page editor with its live preview');

    // Back to Edit: the fields again, the preview kept but hidden.
    await page.setViewportSize({ width: 390, height: 900 });
    await showView(page, 'Edit');
    await expect(page.locator('form.editor')).toBeVisible();
    await expect(previewRegion(page)).toBeHidden();

    // A section clicked in the preview opens in the column, and the fields come back in place
    // of the preview to edit it (E2 review CR5; nothing typed, so nothing is asked).
    await showView(page, 'Preview');
    await expect(inPreview(page, 'aboutWho')).toHaveClass(OUTLINED);
    await inPreview(page, 'leadership').dispatchEvent('click');
    await expect(rowOf(page, 'Leadership')).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('form.editor')).toBeVisible();
    await expect(previewRegion(page)).toBeHidden();
    await expect(
      page.getByRole('group', { name: 'Show', exact: true }).getByRole('radio', { name: 'Edit' }),
    ).toBeChecked();
  });

  test('narrow screens: a save, a section and a language chosen in Edit wait for Preview', async ({
    page,
  }) => {
    const arabic: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/admin/preview/ar'))
        arabic.push(request.url());
    });
    await page.setViewportSize({ width: 390, height: 900 });
    await openEditor(page, aboutId);
    await showView(page, 'Preview');
    await expect(inPreview(page, 'aboutWho')).toHaveClass(OUTLINED);
    const frame = await previewFrame(page);
    await mark(frame);

    // A save while Edit shows: the hidden preview is not reloaded (P-15)...
    await showView(page, 'Edit');
    await expect(previewRegion(page)).toBeHidden();
    const done = await routeSave(page, 'aboutWho');
    await page.locator('#f-content-heading-en').fill(`Hidden ${MARK}`);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.locator('.save-status[data-state="saved"]')).toBeVisible();
    await page.waitForTimeout(1000); // past the 250 ms burst delay
    expect(await marked(frame)).toBe(true);
    // ...until Preview is chosen again: then it is, once.
    await showView(page, 'Preview');
    await expect.poll(() => marked(frame)).toBe(false);
    await expect(inPreview(page, 'aboutWho')).toHaveClass(OUTLINED);
    await done();

    // Numbers is below the phone's first screen while Who we are is shown...
    await expect.poll(() => inView(frame, 'aboutWho')).toBe(true);
    expect(await inView(frame, 'statistics')).toBe(false);
    // ...opened while Edit shows, the preview jumps to it once Preview is chosen (E2-C1).
    await showView(page, 'Edit');
    await pick(page, 'Numbers').click();
    await expect(rowOf(page, 'Numbers')).toHaveAttribute('aria-current', 'true');
    await showView(page, 'Preview');
    await expect.poll(() => inView(frame, 'statistics')).toBe(true);
    await expect(inPreview(page, 'statistics')).toHaveClass(OUTLINED);

    // The editor's Arabic while Edit shows: the hidden frame keeps its page and asks for none
    // (E2-C2); Preview loads the Arabic page, at Numbers.
    await showView(page, 'Edit');
    await page
      .getByRole('group', { name: 'This page' })
      .getByRole('group', { name: 'Editing language' })
      .getByRole('radio', { name: 'العربية' })
      .check();
    await page.waitForTimeout(1000);
    await expect(page.locator(FRAME)).toHaveAttribute('src', '/admin/preview/about');
    expect(arabic).toEqual([]);
    await showView(page, 'Preview');
    await expect(page.locator(FRAME)).toHaveAttribute('src', '/admin/preview/ar/about');
    await expect(page.frameLocator(FRAME).locator('html')).toHaveAttribute('lang', 'ar');
    await expect(inPreview(page, 'statistics')).toHaveClass(OUTLINED);
    expect(arabic.length).toBeGreaterThan(0);
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
