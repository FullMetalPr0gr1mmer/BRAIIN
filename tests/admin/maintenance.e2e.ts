import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { SKIP_REASON, authFile, staffEnv } from './staff';
import { alterSignature } from './tamper';

// Maintenance v2 (Admin v2 U9b) end to end, through the real Worker, middleware, KV and
// session check: the README's TDD acceptance row "503 for visitors, signed-in admin passes,
// fail-closed". As Admin through the API:
//   1. on, the bypass on: a visitor gets / as a 503 (Retry-After 3600, no-store, the strict
//      CSP, English), and /ar/ in Arabic, right to left;
//   2. the admin's own session gets / as the real page, private, no-store;
//   3. the same session with its token's signature altered gets the 503 (fail closed);
//   4. the bypass off: the admin gets the 503 too;
//   5. "Back on" tomorrow, shown: Retry-After within a minute and a day, the date on the page;
//   6. /healthz, /admin and a listed /_image still answer during maintenance;
//   7. an allowed address passes;
//   8. the screen: Turn on through its confirmation, the banner says so, Turn off;
// and "Preview full screen" is axe-clean with no CSP violation.
//
// Its own project, run last (playwright.config.ts `maintenance`): it takes the shared preview
// down. Every test turns maintenance off when it ends, and the project's teardown
// (maintenance.teardown.ts) does too, so a crashed run leaves the site up.

test.skip(!staffEnv(), SKIP_REASON);
test.describe.configure({ mode: 'serial' });
test.use({ storageState: authFile('admin'), contextOptions: { reducedMotion: 'reduce' } });

const API = '/api/admin/settings/maintenance';
const PREVIEW = '/api/admin/settings/maintenance/preview';
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const SESSION = '__Host-braiin-auth';

async function csrf(page: Page): Promise<string> {
  // By the token itself, not the address: the preview test ends on /api/admin/…/preview, a
  // bare maintenance page with no admin layout and so no token.
  if ((await page.locator('meta[name="csrf-token"]').count()) === 0) {
    await page.goto('/admin', { waitUntil: 'networkidle' });
  }
  const token = await page.locator('meta[name="csrf-token"]').getAttribute('content');
  expect(token, 'the admin layout carries a CSRF token').toBeTruthy();
  return token!;
}

/** Saves maintenance as Admin at the current version, with `patch` over the off defaults. */
async function setMaintenance(page: Page, patch: Record<string, unknown>) {
  const current = await page.request.get(API);
  expect(current.status()).toBe(200);
  const { version } = ((await current.json()) as { data: { version: number } }).data;
  const res = await page.request.patch(API, {
    headers: { 'x-csrf-token': await csrf(page), origin: new URL(page.url()).origin },
    data: {
      active: false,
      allowlist: [],
      staffBypass: true,
      until: null,
      showDate: false,
      background: 'image',
      showContact: true,
      title: null,
      message: null,
      ...patch,
      version,
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { data: { kvSynced: boolean } };
  expect(body.data.kvSynced, 'the edge took the change').toBe(true);
}

/** A context with no session: a visitor. */
async function visitor(browser: Browser) {
  return browser.newContext({ storageState: { cookies: [], origins: [] } });
}

/** A day in Riyadh (the seed's studio zone), `days` from today. */
function riyadhDay(days: number): string {
  return new Date(Date.now() + 3 * 3_600_000 + days * 86_400_000).toISOString().slice(0, 10);
}

test.afterEach(async ({ page }) => {
  await setMaintenance(page, { active: false });
});

test('a visitor gets the 503, in English and in Arabic', async ({ page, browser }) => {
  await setMaintenance(page, { active: true, staffBypass: true });
  const ctx = await visitor(browser);
  const res = await ctx.request.get('/', { maxRedirects: 0 });
  expect(res.status()).toBe(503);
  expect(res.headers()['retry-after']).toBe('3600');
  expect(res.headers()['cache-control']).toBe('no-store');
  expect(res.headers()['content-security-policy']).toMatch(/style-src[^;]*'nonce-/);
  const html = await res.text();
  expect(html).toContain('<html lang="en" dir="ltr">');
  const ar = await ctx.request.get('/ar/', { maxRedirects: 0 });
  expect(ar.status()).toBe(503);
  const arHtml = await ar.text();
  expect(arHtml).toContain('<html lang="ar" dir="rtl">');
  expect(arHtml).toContain('نجهّز شي جديد.');
  await ctx.close();
});

test('the signed-in admin sees the site, private; an altered token does not', async ({
  page,
  browser,
}) => {
  await setMaintenance(page, { active: true, staffBypass: true });
  const res = await page.request.get('/', { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toBe('private, no-store');
  expect(res.headers()['x-robots-tag']).toBe('noindex');
  expect(res.headers()['cache-tag']).toBeUndefined();

  // The session cookie, joined from its chunks, with the access token's signature changed
  // (its bytes, not only its text: tamper.ts): the local pre-filter passes it, the auth
  // server refuses it.
  const cookies = await page.context().cookies();
  const parts = cookies
    .filter((c) => c.name === SESSION || c.name.startsWith(`${SESSION}.`))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  expect(parts.length, 'the admin session has its cookie').toBeGreaterThan(0);
  const value = parts.map((c) => c.value).join('');
  const json = value.startsWith('base64-')
    ? Buffer.from(value.slice(7), 'base64url').toString('utf8')
    : decodeURIComponent(value);
  const session = JSON.parse(json) as { access_token: string };
  session.access_token = alterSignature(session.access_token);
  const forged = `base64-${Buffer.from(JSON.stringify(session), 'utf8').toString('base64url')}`;
  const tampered = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  await tampered.addCookies([{ ...parts[0]!, name: SESSION, value: forged }]);
  expect((await tampered.request.get('/', { maxRedirects: 0 })).status()).toBe(503);
  await tampered.close();
});

test('with the bypass off, the admin gets the 503 too', async ({ page }) => {
  await setMaintenance(page, { active: true, staffBypass: false });
  expect((await page.request.get('/', { maxRedirects: 0 })).status()).toBe(503);
});

test('"Back on" tomorrow, shown: Retry-After counts down, the date is on the page', async ({
  page,
  browser,
}) => {
  await setMaintenance(page, { active: true, until: riyadhDay(1), showDate: true });
  const ctx = await visitor(browser);
  const res = await ctx.request.get('/', { maxRedirects: 0 });
  expect(res.status()).toBe(503);
  const wait = Number(res.headers()['retry-after']);
  expect(wait).toBeGreaterThanOrEqual(60);
  expect(wait).toBeLessThanOrEqual(86_400);
  expect(await res.text()).toMatch(/<p class="when">Back on \d{1,2} [A-Z][a-z]+( \d{4})?<\/p>/);
  await ctx.close();
});

test('/healthz, /admin and a listed /_image still answer', async ({ page, browser }) => {
  await page.goto('/admin', { waitUntil: 'networkidle' });
  const still = await page.locator('img[src^="/_image"]').first().getAttribute('src');
  expect(still, 'the admin shows a transformed still').toBeTruthy();
  await setMaintenance(page, { active: true, staffBypass: false });
  const ctx = await visitor(browser);
  expect((await ctx.request.get('/healthz')).status()).toBe(200);
  expect((await ctx.request.get(still!.replace(/&amp;/g, '&'))).status()).toBe(200);
  expect((await page.request.get('/admin', { maxRedirects: 0 })).status()).toBe(200);
  await ctx.close();
});

test('an allowed address passes', async ({ page, browser }) => {
  // The address the Worker reads is cf-connecting-ip. Under the local preview it may be the
  // loopback's rather than the header this test sends, so all three are allowed: the request
  // passes only through the allowlist (the bypass is off and the context has no session).
  // tests/lib/middlewareMaintenance.spec.ts holds the exact address match and its canonical
  // IPv6 form.
  await setMaintenance(page, {
    active: true,
    staffBypass: false,
    allowlist: ['203.0.113.77', '127.0.0.1', '::1'],
  });
  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { 'cf-connecting-ip': '203.0.113.77' },
  });
  expect((await ctx.request.get('/', { maxRedirects: 0 })).status()).toBe(200);
  await ctx.close();
});

test('the screen: Turn on through the confirmation, the banner says so, Turn off', async ({
  page,
}) => {
  const violations: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') violations.push(m.text());
  });
  await page.goto('/admin/maintenance', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'The site is live' })).toBeVisible();
  const axe = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);

  await page.getByRole('button', { name: 'Turn on' }).click();
  const dialog = page.getByRole('dialog', { name: 'Put the site in maintenance mode?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByRole('heading', { name: 'Maintenance mode is on' })).toBeVisible();

  await page.getByRole('button', { name: 'Turn off' }).click();
  await expect(page.getByRole('heading', { name: 'The site is live' })).toBeVisible();
  expect(violations).toEqual([]);
});

test('Preview full screen: the saved page, 200, private, axe-clean, no CSP violation', async ({
  page,
}) => {
  await setMaintenance(page, {
    active: false,
    title: { en: 'Back very soon', ar: 'نعود قريبًا جدًا' },
  });
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  for (const lang of ['en', 'ar'] as const) {
    const res = await page.goto(`${PREVIEW}?lang=${lang}`);
    expect(res?.status()).toBe(200);
    expect(res?.headers()['cache-control']).toContain('no-store');
    // A private /api/admin answer: the middleware's Tier C rule makes it 'noindex, nofollow'.
    expect(res?.headers()['x-robots-tag']).toBe('noindex, nofollow');
    await expect(page.locator('h1')).toHaveText(
      lang === 'en' ? 'Back very soon' : 'نعود قريبًا جدًا',
    );
    const axe = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(
      axe.violations.map((v) => v.id),
      lang,
    ).toEqual([]);
  }
  expect(errors).toEqual([]);
});
