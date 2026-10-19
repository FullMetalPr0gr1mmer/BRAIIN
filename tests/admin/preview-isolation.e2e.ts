import AxeBuilder from '@axe-core/playwright';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';
import { mayRead } from '@/lib/admin/help/access';
import { PAGE_GUIDES } from '@/lib/admin/help/pageGuides';
import { ROUTES } from '../e2e/publicRoutes';
import { SKIP_REASON, STAFF_ROLES, authFile, staffEnv } from './staff';

// Preview isolation (Admin v2 R9; releases.md §9): the preview is private, no-store, carries
// no Cache-Tag and is never indexed; a pending change shows in the preview and nowhere else;
// a public page never carries the bridge, the ribbon or the markers; every CMS role opens it;
// the ribbon passes axe; in the page, links stay in the preview and forms never send.
//
// The pending change is written straight into content_drafts with the local stack's service
// role (releases are off in CI, so no admin route stages one yet) and removed at the end.
//
// The preview's own 404 (src/pages/admin/preview/[...path].astro) is an admin screen the
// per-role sweep cannot open (it expects 200): this file runs the sweep's checks on it, at
// 320, 390 and 1280, for every role that may preview.

const env = staffEnv();
test.skip(!env && !process.env['CI'], SKIP_REASON);
test.describe.configure({ mode: 'serial' });
test.use({ storageState: authFile('admin'), contextOptions: { reducedMotion: 'reduce' } });

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const PENDING_TITLE = 'Preview only title';
/** As the per-role sweep (tests/admin/sweep.e2e.ts). */
const OVERFLOW_PX = 2;

// Who may preview: the roles the preview guide is for (its page-guide entry, PAGE_GUIDES).
// tests/lib/previewGuide.spec.ts holds the entry's caps to the guide's and to
// PREVIEW_READ_CAPS, and its readers to `canPreview`, which this runner cannot import (its
// graph reaches the Worker's bindings). A role the matrix adds without a preview area
// (C10a's Sales) lands in REFUSED, not in a loop that expects a 200.
const GUIDE_CAPS = PAGE_GUIDES.find((guide) => guide.slug === 'previewing-changes')!.caps;
const PREVIEWERS = STAFF_ROLES.filter((role) => mayRead(role, GUIDE_CAPS));
const REFUSED = STAFF_ROLES.filter((role) => !mayRead(role, GUIDE_CAPS));

/**
 * Listens for what the sweep fails on in a live page: a page error, a console error and a
 * CSP violation. Call before the first navigation; call the result to read them. A console
 * error carries the URL it is about, as in the sweep, so a test can tell which resource it
 * names.
 */
async function watchLive(page: Page): Promise<() => Promise<string[]>> {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const where = message.location().url;
    problems.push(`console: ${message.text()}${where ? ` (${where})` : ''}`);
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      w.__csp.push(`${event.violatedDirective} ${event.blockedURI || 'inline'}`);
    });
  });
  return async () => {
    const csp = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
    return [...problems, ...csp.map((v) => `csp: ${v}`)];
  };
}

function service() {
  return createClient(env!.url, env!.serviceKey, { auth: { persistSession: false } });
}

test('the preview is private, never cached or indexed, and sends no form', async ({ request }) => {
  const res = await request.get('/admin/preview/about', { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  const h = res.headers();
  expect(h['cache-control']).toBe('private, no-store, max-age=0, must-revalidate');
  expect(h['cache-tag']).toBeUndefined();
  expect(h['x-robots-tag']).toBe('noindex, nofollow');
  const csp = h['content-security-policy'] ?? '';
  expect(csp).toContain("form-action 'none'");
  expect(csp).toMatch(/frame-src 'self' /);
  expect(csp).not.toContain('unsafe-inline');
  const html = await res.text();
  expect(html).toContain('<meta name="robots" content="noindex,nofollow"');
  expect(html).toContain('data-pv-ribbon');
  expect(html).toContain('/styles/preview.css');
  expect(html).toMatch(/AdminPreviewBridge\.astro_[^"]*\.js/);
  expect(html).toContain('data-pv-section=');
  expect(html).not.toContain('consent-banner');
});

test('a public page never carries the bridge, the ribbon, the markers or same-origin framing', async ({
  request,
}) => {
  for (const route of ROUTES) {
    const res = await request.get(route, { maxRedirects: 0 });
    const html = await res.text();
    for (const mark of [
      'AdminPreviewBridge',
      'admin-preview',
      'pv-ribbon',
      'data-pv-section',
      'preview.css',
    ]) {
      expect(html, `${route}: ${mark}`).not.toContain(mark);
    }
    expect(res.headers()['content-security-policy'] ?? '', route).not.toMatch(/frame-src 'self'/);
  }
});

test('signed out, the preview is the sign-in page and renders nothing', async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const res = await context.request.get('/admin/preview/services', { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  expect(res.headers()['location']).toMatch(/^\/admin\/login\?next=/);
  await context.close();
});

for (const role of PREVIEWERS) {
  test(`${role} opens the preview, and its ribbon passes axe`, async ({ browser }) => {
    const context = await browser.newContext({ storageState: authFile(role) });
    const page = await context.newPage();
    const live = await watchLive(page);
    const res = await page.goto('/admin/preview/ar/contact', { waitUntil: 'networkidle' });
    expect(res?.status()).toBe(200);
    await expect(page.locator('.pv-ribbon')).toBeVisible();
    const axe = await new AxeBuilder({ page }).include('.pv-ribbon').withTags(WCAG).analyze();
    expect(axe.violations).toEqual([]);
    expect(await live(), 'page errors, console errors and CSP violations').toEqual([]);
    await context.close();
  });

  test(`${role}: the preview's own 404 passes the sweep's checks at 320, 390 and 1280`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: authFile(role) });
    const page = await context.newPage();
    const path = '/admin/preview/robots.txt';

    // Server HTML, as the sweep reads it: parsed, never run.
    const res = await page.request.get(path, { maxRedirects: 0 });
    expect(res.status()).toBe(404);
    const headers = res.headers();
    expect.soft(headers['cache-control'] ?? '', 'Cache-Control').toContain('no-store');
    expect.soft(headers['content-security-policy'] ?? '').not.toContain("'unsafe-inline'");
    const styled = await page.evaluate(
      (markup) => {
        const doc = new DOMParser().parseFromString(markup, 'text/html');
        return [...doc.querySelectorAll('[style]')].map((el) => el.outerHTML.slice(0, 160));
      },
      await res.text(),
    );
    expect.soft(styled, 'style= attributes in the server HTML').toEqual([]);

    // The live page at each width: no overflow, axe clean (target-size is wcag22aa).
    const live = await watchLive(page);
    const widths = [320, 390, 1280];
    let documentUrl = '';
    for (const width of widths) {
      await page.setViewportSize({ width, height: 800 });
      const shown = await page.goto(path, { waitUntil: 'networkidle' });
      expect(shown?.status()).toBe(404);
      documentUrl = shown?.url() ?? '';
      await expect(page.getByText("This page can't be previewed")).toBeVisible();
      const overflow = await page.evaluate(() => {
        const root = document.documentElement;
        const main = document.querySelector('main.admin-main');
        return {
          page: root.scrollWidth - root.clientWidth,
          main: main ? main.scrollWidth - main.clientWidth : 0,
        };
      });
      expect.soft(overflow.page, `page overflow at ${width}px`).toBeLessThanOrEqual(OVERFLOW_PX);
      expect.soft(overflow.main, `content overflow at ${width}px`).toBeLessThanOrEqual(OVERFLOW_PX);
      const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
      expect
        .soft(
          violations.map((v) => `${v.id} ${v.nodes.length}x: ${v.help}`),
          `axe WCAG 2.2 A/AA at ${width}px`,
        )
        .toEqual([]);
    }
    // Chromium reports every document that answers 404 as a console error about that
    // document ("Failed to load resource: … 404"): the status this page must answer, once per
    // load. Those three reports, of this document, and nothing else: a resource the page
    // fails to load, a script error or a CSP violation still fails here.
    const statusReport = `console: Failed to load resource: the server responded with a status of 404 (Not Found) (${documentUrl})`;
    expect(await live(), 'page errors, console errors and CSP violations').toEqual(
      widths.map(() => statusReport),
    );
    await context.close();
  });
}

for (const role of REFUSED) {
  test(`${role} may not preview: 403, nothing rendered`, async ({ browser }) => {
    const context = await browser.newContext({ storageState: authFile(role) });
    const res = await context.request.get('/admin/preview/about', { maxRedirects: 0 });
    expect(res.status()).toBe(403);
    expect(await res.text()).not.toContain('data-pv-ribbon');
    await context.close();
  });
}

test('a pending change shows in the preview and only there', async ({ request }) => {
  const svc = service();
  const { data: row, error } = await svc
    .from('services')
    .select('id,tenant_id')
    .eq('slug', 'logo')
    .single();
  expect(error).toBeNull();
  const { data: draft, error: insertError } = await svc
    .from('content_drafts')
    .insert({
      tenant_id: row!.tenant_id,
      entity_type: 'service',
      entity_id: row!.id,
      op: 'update',
      payload: { title: { en: PENDING_TITLE, ar: 'عنوان للمعاينة فقط' } },
      fields: ['title'],
    })
    .select('id')
    .single();
  expect(insertError).toBeNull();
  try {
    // R8's anon-lookup tripwire is isolate-wide (its D1): a public page the same isolate
    // serves during this render (the public specs run in parallel) marks the ribbon
    // untrusted, and an untrusted ribbon shows no count. The change shows either way; the
    // count is asserted on a render the ribbon trusts, asked for a few times (departure 6).
    const url = `/admin/preview/services/logo?only=${draft!.id}`;
    let html = '';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      html = await (await request.get(url)).text();
      expect(html).toContain(PENDING_TITLE);
      if (html.includes('data-state="ok"')) break;
    }
    if (html.includes('data-state="ok"')) expect(html).toContain('1 unpublished change');
    else expect(html).toContain('data-state="untrusted"');
    const arabic = await request.get(`/admin/preview/ar/services/logo?only=${draft!.id}`);
    expect(await arabic.text()).toContain('عنوان للمعاينة فقط');
    const live = await request.get('/services/logo');
    expect(await live.text()).not.toContain(PENDING_TITLE);
  } finally {
    await svc.from('content_drafts').delete().eq('id', draft!.id);
  }
});

test('in the preview, a link stays in the preview and a form never sends', async ({ page }) => {
  const posts: string[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET' && r.method() !== 'HEAD') posts.push(r.url());
  });
  const live = await watchLive(page);
  await page.goto('/admin/preview/contact', { waitUntil: 'networkidle' });
  await page.locator('a[href="/about"]:visible').first().click();
  await expect(page).toHaveURL(/\/admin\/preview\/about$/);
  await page.goto('/admin/preview/contact', { waitUntil: 'networkidle' });
  const form = page
    .locator('form')
    .filter({ has: page.locator('[type="submit"]') })
    .first();
  await form.evaluate((f: HTMLFormElement) => f.requestSubmit());
  await expect(page.locator('.pv-notice')).toHaveText("Forms don't send in preview.");
  expect(posts).toEqual([]);
  expect(await live(), 'page errors, console errors and CSP violations').toEqual([]);
});

test('a search typed into the preview never reaches /api/search, which records it', async ({
  page,
}) => {
  const searches: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/search')) searches.push(r.url());
  });
  await page.goto('/admin/preview/search', { waitUntil: 'networkidle' });
  await page.locator('#search-input').fill('logo');
  // The page's debounce is 250 ms: wait well past it, as long as it would have taken to send.
  await page.waitForTimeout(1000);
  expect(searches).toEqual([]);
});

test('a preview of /search?q= runs no search at start-up either, and logs nothing', async ({
  page,
}) => {
  // The search page runs an initial `?q=` as soon as its script runs. The bridge is in the
  // head, so it refuses that request before it leaves; the CSP's connect-src (exact
  // READ_ONLY_ENDPOINTS) would refuse it too, with a console error and a violation, which
  // watchLive fails on.
  const searches: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/search')) searches.push(r.url());
  });
  const live = await watchLive(page);
  for (const path of ['/admin/preview/search?q=logo', '/admin/preview/ar/search?q=logo']) {
    const res = await page.goto(path, { waitUntil: 'networkidle' });
    expect(res?.status(), path).toBe(200);
    const connect = (res?.headers()['content-security-policy'] ?? '')
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('connect-src '));
    expect(connect, path).toMatch(/^connect-src https?:\/\/\S+\/api\/apply\/status$/);
    await expect(page.locator('#search-input')).toHaveValue('logo');
    await page.waitForTimeout(500);
  }
  expect(searches).toEqual([]);
  expect(await live(), 'page errors, console errors and CSP violations').toEqual([]);
});
