import AxeBuilder from '@axe-core/playwright';
import { createClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';
import { ROUTES } from '../e2e/publicRoutes';
import { SKIP_REASON, STAFF_ROLES, authFile, staffEnv } from './staff';

// Preview isolation (Admin v2 R9; releases.md §9): the preview is private, no-store, carries
// no Cache-Tag and is never indexed; a pending change shows in the preview and nowhere else;
// a public page never carries the bridge, the ribbon or the markers; every CMS role opens it;
// the ribbon passes axe; in the page, links stay in the preview and forms never send.
//
// The pending change is written straight into content_drafts with the local stack's service
// role (releases are off in CI, so no admin route stages one yet) and removed at the end.

const env = staffEnv();
test.skip(!env && !process.env['CI'], SKIP_REASON);
test.describe.configure({ mode: 'serial' });
test.use({ storageState: authFile('admin'), contextOptions: { reducedMotion: 'reduce' } });

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const PENDING_TITLE = 'Preview only title';

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

for (const role of STAFF_ROLES) {
  test(`${role} opens the preview, and its ribbon passes axe`, async ({ browser }) => {
    const context = await browser.newContext({ storageState: authFile(role) });
    const page = await context.newPage();
    const res = await page.goto('/admin/preview/ar/contact', { waitUntil: 'networkidle' });
    expect(res?.status()).toBe(200);
    await expect(page.locator('.pv-ribbon')).toBeVisible();
    const axe = await new AxeBuilder({ page }).include('.pv-ribbon').withTags(WCAG).analyze();
    expect(axe.violations).toEqual([]);
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
    const preview = await request.get(`/admin/preview/services/logo?only=${draft!.id}`);
    const html = await preview.text();
    expect(html).toContain(PENDING_TITLE);
    expect(html).toContain('1 unpublished change');
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
});
