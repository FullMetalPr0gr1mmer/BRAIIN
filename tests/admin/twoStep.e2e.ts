import AxeBuilder from '@axe-core/playwright';
import { createClient } from '@supabase/supabase-js';
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type Response,
} from '@playwright/test';
import { SKIP_REASON, authFile, ensureAccount, staffEnv } from './staff';
import { totp, untilNextStep } from './totp';

/*
 * Two step sign in (Admin v2 U17) end to end, on the local stack, with an account of its own
 * (never a shared role session: a reset signs it out everywhere, and a factor on a shared
 * account would hold every other spec at the second step):
 *
 *   1. signed in, the account row says Off; Set up, read the key off the page, type the code
 *      an authenticator would show (tests/admin/totp.ts, RFC 6238), and the row says On;
 *   2. signed out and in again, the password lands on /admin/2fa; every admin page sends it
 *      back there and the admin API answers 401 two-step-required; a wrong code says so; the
 *      right one finishes the sign-in at `next`;
 *   3. the database layer: before the code, the access token carries no role (the hook,
 *      0072) and reads nothing a role is needed for straight from PostgREST, and GoTrue
 *      refuses it both adding a factor and removing the verified one (insufficient_aal);
 *      after the code, aal2 and the role, and the same read answers;
 *   4. the shared Admin resets its 2FA on Users & roles: its session ends at its next
 *      request, its next sign-in goes straight in, and the activity log says so;
 *   5. every /admin/2fa step and the account row: axe (WCAG 2.2 A/AA), no sideways scroll at
 *      320, 390 and 1280, no CSP violation, no console error, no `style=` in the server HTML.
 *
 * Require 2FA for everyone is not switched on here: every shared role session would be held
 * at the second step mid-run. Forced setup is covered by the unit suites (authContext,
 * middlewareTwoStep, the page's render) and pgTAP (two_step.test.sql).
 */

test.skip(!staffEnv(), SKIP_REASON);
// freshCode() may wait out a whole 30 s step before a test's real work starts: Playwright's
// default timeout (30 s) would end the test inside that wait (tests/lib/twoStepE2e.spec.ts).
test.describe.configure({ mode: 'serial', timeout: 120_000 });
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const WIDTHS = [320, 390, 1280] as const;

/** This spec's account: a Developer, so it reads the activity log (a role-gated read). */
const ACCOUNT = {
  id: 'e2e00000-0000-4000-8000-0000000002fa',
  email: 'e2e-2fa@example.com',
  role: 'developer' as const,
  displayName: 'E2E Two step',
};

let password = '';
/** The setup key the page showed (the authenticator's secret). */
let key = '';
/** The 30-second step whose code was last typed: GoTrue refuses a code used once. */
let lastStep = -1;

function service() {
  const env = staffEnv()!;
  return createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

test.beforeAll(async () => {
  const env = staffEnv()!;
  ({ password } = await ensureAccount(env, ACCOUNT));
  // A re-run starts with no factor (a failed run may have left one).
  const svc = service();
  const { data } = await svc.auth.admin.mfa.listFactors({ userId: ACCOUNT.id });
  for (const factor of data?.factors ?? []) {
    await svc.auth.admin.mfa.deleteFactor({ id: factor.id, userId: ACCOUNT.id });
  }
});

/** A code from a step no code was typed in yet (waits for the next step when needed). */
async function freshCode(page: Page): Promise<string> {
  if (Math.floor(Date.now() / 30_000) === lastStep) {
    await page.waitForTimeout(untilNextStep() + 500);
  }
  lastStep = Math.floor(Date.now() / 30_000);
  return totp(key);
}

/** A code no window around now accepts. */
function wrongCode(): string {
  const near = [-30_000, 0, 30_000].map((d) => totp(key, Date.now() + d));
  for (let n = 0; ; n += 1) {
    const candidate = String((Number(near[1]) + 111_111 * (n + 1)) % 1_000_000).padStart(6, '0');
    if (!near.includes(candidate)) return candidate;
  }
}

/** A fresh browser with no session, recording CSP violations and console errors. */
async function freshContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  await context.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      w.__csp.push(`${event.violatedDirective} ${event.blockedURI || 'inline'}`);
    });
  });
  return context;
}

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function signIn(page: Page) {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(ACCOUNT.email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** The server's HTML for a document response: no `style=` attribute (CSP, CLAUDE.md §3). */
async function expectNoInlineStyle(response: Response | null, label: string) {
  expect(response, label).not.toBeNull();
  expect(await response!.text(), `${label}: no style= in the server HTML`).not.toMatch(/\sstyle=/);
}

/** axe, sideways scroll and CSP at each width, on the page as it stands. */
async function expectClean(page: Page, label: string) {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    const sideways = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(sideways, `${label} at ${width}: no sideways scroll`).toBeLessThanOrEqual(1);
    const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(
      violations.map((v) => `${v.id} [${v.impact ?? 'n/a'}] ${v.nodes.length}x: ${v.help}`),
      `${label} at ${width}`,
    ).toEqual([]);
  }
  const csp = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
  expect(csp, `${label}: no CSP violation`).toEqual([]);
}

/** The access token in a context's session cookie (@supabase/ssr, maybe chunked). */
async function accessTokenOf(context: BrowserContext): Promise<string> {
  const chunks = (await context.cookies())
    .filter((c) => c.name === '__Host-braiin-auth' || c.name.startsWith('__Host-braiin-auth.'))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  const raw = chunks.map((c) => c.value).join('');
  const json = raw.startsWith('base64-')
    ? Buffer.from(raw.slice('base64-'.length), 'base64url').toString('utf8')
    : decodeURIComponent(raw);
  const session = JSON.parse(json) as { access_token?: string };
  expect(session.access_token, 'the session cookie carries an access token').toBeTruthy();
  return session.access_token!;
}

function claimsOf(token: string): Record<string, unknown> {
  const payload = token.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** The local Supabase the e2e job names, and its anon key. */
function localSupabase(): { supabase: string; anon: string } {
  const supabase = (process.env['PUBLIC_SUPABASE_URL'] ?? '').replace(/\/$/, '');
  const anon = process.env['PUBLIC_SUPABASE_ANON_KEY'] ?? '';
  expect(supabase && anon, 'the e2e job names a local Supabase and its anon key').toBeTruthy();
  return { supabase, anon };
}

/** This account's activity log rows, read straight from PostgREST with a token. */
async function auditRowsWith(context: BrowserContext, token: string): Promise<unknown[]> {
  const { supabase, anon } = localSupabase();
  const res = await context.request.get(
    `${supabase}/rest/v1/audit_log?select=id&actor_id=eq.${ACCOUNT.id}&limit=5`,
    { headers: { apikey: anon, authorization: `Bearer ${token}` } },
  );
  if (res.status() !== 200) return [];
  return (await res.json()) as unknown[];
}

/**
 * GoTrue's own factor endpoints, called with a token as the account's browser could call them
 * (supabase-js's mfa.enroll / mfa.unenroll): the status and GoTrue's error code.
 */
async function gotrue(
  context: BrowserContext,
  method: 'POST' | 'DELETE',
  path: string,
  token: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; code: unknown }> {
  const { supabase, anon } = localSupabase();
  const res = await context.request.fetch(`${supabase}/auth/v1${path}`, {
    method,
    headers: { apikey: anon, authorization: `Bearer ${token}` },
    ...(body ? { data: body } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as { error_code?: unknown };
  return { status: res.status(), code: json.error_code };
}

/** Every factor the account has, verified or not, as the service role sees them. */
async function factorsOfAccount(): Promise<{ id: string; status: string }[]> {
  const { data, error } = await service().auth.admin.mfa.listFactors({ userId: ACCOUNT.id });
  expect(error, 'the service role lists the factors').toBeNull();
  return (data?.factors ?? []).map((f) => ({ id: f.id, status: f.status }));
}

test('sets 2FA up from the account: the key, a code, and the row says On', async ({ browser }) => {
  const context = await freshContext(browser);
  const page = await context.newPage();
  const errors = watchConsole(page);
  await signIn(page);
  await page.waitForURL((url) => url.pathname === '/admin');

  await page.goto('/admin/account');
  const row = page.locator('li', { hasText: 'Two factor authentication' });
  await expect(row).toContainText('Off. Turn it on to protect the admin.');
  await row.getByRole('link', { name: 'Set up' }).click();
  await page.waitForURL((url) => url.pathname === '/admin/2fa');
  await expect(page.getByRole('heading', { name: 'Set up 2FA' })).toBeVisible();
  await expectNoInlineStyle(await page.reload(), 'the intro');
  await expectClean(page, 'the intro');

  const [started] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/admin/2fa') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Set up' }).click(),
  ]);
  await expectNoInlineStyle(started, 'the setup step');
  await expect(page.getByRole('heading', { name: 'Add this account to your app' })).toBeVisible();
  key = ((await page.locator('code.two-step__key').textContent()) ?? '').replace(/\s+/g, '');
  expect(key).toMatch(/^[A-Z2-7]{16,}$/);
  // The link an authenticator on this device opens: the same key, never a data: QR image.
  const link = await page.getByRole('link', { name: 'Add it to the app' }).getAttribute('href');
  expect(link).toMatch(/^otpauth:\/\/totp\//);
  expect(link).toContain(`secret=${key}`);
  await expect(page.locator('img[src^="data:"]')).toHaveCount(0);
  await expectClean(page, 'the setup step');

  // A wrong code first: the same step again, the same key, nothing counted.
  await page.getByLabel('6-digit code').fill(wrongCode());
  await page.getByRole('button', { name: 'Turn on 2FA' }).click();
  await expect(page.locator('.two-step .msg')).toContainText('That code did not work.');
  await expect(page.locator('code.two-step__key')).toHaveText(/[A-Z2-7 ]+/);
  expect(((await page.locator('code.two-step__key').textContent()) ?? '').replace(/\s+/g, '')).toBe(
    key,
  );

  await page.getByLabel('6-digit code').fill(await freshCode(page));
  await page.getByRole('button', { name: 'Turn on 2FA' }).click();
  await page.waitForURL((url) => url.pathname === '/admin/2fa' && url.searchParams.has('done'));
  await expect(page.getByRole('heading', { name: '2FA is on' })).toBeVisible();
  await expectClean(page, 'manage');

  await page.goto('/admin/account');
  await expect(page.locator('li', { hasText: 'Two factor authentication' })).toContainText(
    'On, via authenticator app.',
  );
  expect(errors, 'no console error').toEqual([]);
  await context.close();
});

test('signing in asks for the code: nothing else answers until it is typed', async ({
  browser,
}) => {
  const context = await freshContext(browser);
  const page = await context.newPage();
  const errors = watchConsole(page);
  await signIn(page);
  await page.waitForURL((url) => url.pathname === '/admin/2fa');
  await expect(page.getByRole('heading', { level: 1, name: 'Enter your code' })).toBeVisible();
  await expectNoInlineStyle(await page.reload(), 'the code at sign-in');
  await expectClean(page, 'the code at sign-in');

  // Every admin page sends it back here, keeping where it was going.
  await page.goto('/admin/audit');
  await page.waitForURL((url) => url.pathname === '/admin/2fa');
  expect(new URL(page.url()).searchParams.get('next')).toBe('/admin/audit');
  const api = await context.request.get('/api/admin/me/preferences');
  expect(api.status()).toBe(401);
  expect(await api.json()).toEqual({ ok: false, error: 'two-step-required' });

  // The database layer: the token minted after the password alone carries no role.
  const aal1 = await accessTokenOf(context);
  const before = claimsOf(aal1);
  expect(before['aal']).toBe('aal1');
  expect(before['app_metadata']).not.toHaveProperty('role');
  expect(before['app_metadata']).not.toHaveProperty('tenant_id');
  expect(await auditRowsWith(context, aal1), 'aal1 reads no activity').toEqual([]);

  // GoTrue's AAL rule, which both layers stand on: the hook stamps the role whenever no
  // verified factor is required, so the password alone must neither remove the factor nor add
  // a second one (which it could then verify). GoTrue answers insufficient_aal to both (403
  // or 422 by endpoint and version; the code is what it promises) and the factor stands.
  const factors = await factorsOfAccount();
  expect(factors, 'one factor, verified, set up in the first test').toHaveLength(1);
  expect(factors[0]!.status).toBe('verified');
  const factorId = factors[0]!.id;
  const enrol = await gotrue(context, 'POST', '/factors', aal1, {
    factor_type: 'totp',
    friendly_name: 'A second app',
  });
  expect([403, 422], 'enrolling a second app at aal1 is refused').toContain(enrol.status);
  expect(enrol.code).toBe('insufficient_aal');
  const unenrol = await gotrue(context, 'DELETE', `/factors/${factorId}`, aal1);
  expect([403, 422], 'removing the verified factor at aal1 is refused').toContain(unenrol.status);
  expect(unenrol.code).toBe('insufficient_aal');
  expect(await factorsOfAccount(), 'the factor stands, and no other was added').toEqual([
    { id: factorId, status: 'verified' },
  ]);

  // A wrong code says so, and keeps the page.
  await page.getByLabel('6-digit code').fill(wrongCode());
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.locator('.two-step .msg')).toContainText('That code did not work.');
  await expectClean(page, 'a wrong code');

  await page.getByLabel('6-digit code').fill(await freshCode(page));
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.waitForURL((url) => url.pathname === '/admin/audit');

  const aal2 = await accessTokenOf(context);
  const after = claimsOf(aal2);
  expect(after['aal']).toBe('aal2');
  expect(after['app_metadata']).toMatchObject({ role: 'developer' });
  expect((await auditRowsWith(context, aal2)).length, 'aal2 reads its activity').toBeGreaterThan(0);
  expect(errors, 'no console error').toEqual([]);
  await context.close();
});

test('an Admin resets it: signed out everywhere, then signed in with the password alone', async ({
  browser,
}) => {
  // The account holds a session at aal2 (signed in with its code).
  const context = await freshContext(browser);
  const page = await context.newPage();
  await signIn(page);
  await page.waitForURL((url) => url.pathname === '/admin/2fa');
  await page.getByLabel('6-digit code').fill(await freshCode(page));
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.waitForURL((url) => url.pathname === '/admin');

  // The shared Admin: the 2FA column says On; Reset 2FA, confirmed.
  const adminContext = await browser.newContext({ storageState: authFile('admin') });
  const admin = await adminContext.newPage();
  await admin.goto('/admin/users', { waitUntil: 'networkidle' });
  await admin.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  const person = admin.getByRole('row', { name: new RegExp(ACCOUNT.displayName) });
  await expect(person).toContainText('On');
  const edit = admin.getByRole('button', { name: `Edit ${ACCOUNT.displayName}`, exact: true });
  await edit.focus();
  await edit.click();
  await admin.getByRole('button', { name: 'Reset 2FA' }).click();
  const confirm = admin.getByRole('dialog', { name: `Reset 2FA for ${ACCOUNT.displayName}?` });
  await expect(confirm).toBeVisible();
  for (const width of WIDTHS) {
    await admin.setViewportSize({ width, height: 900 });
    const { violations } = await new AxeBuilder({ page: admin }).withTags(WCAG).analyze();
    expect(
      violations.map((v) => `${v.id}: ${v.help}`),
      `the confirm at ${width}`,
    ).toEqual([]);
  }
  await confirm.getByRole('button', { name: 'Reset 2FA' }).click();
  await expect(admin.getByText(`2FA reset. ${ACCOUNT.displayName} is signed out.`)).toBeVisible();

  // Its next request finds its session gone.
  await page.goto('/admin');
  await page.waitForURL((url) => url.pathname === '/admin/login');
  // And its next sign-in goes straight in: no factor, and the team does not require one.
  await signIn(page);
  await page.waitForURL((url) => url.pathname === '/admin');
  await page.goto('/admin/account');
  await expect(page.locator('li', { hasText: 'Two factor authentication' })).toContainText(
    'Off. Turn it on to protect the admin.',
  );

  // The activity log names the reset.
  await admin.goto('/admin/audit');
  await expect(admin.getByText('Reset the 2FA of').first()).toBeVisible();
  await adminContext.close();
  await context.close();
});
