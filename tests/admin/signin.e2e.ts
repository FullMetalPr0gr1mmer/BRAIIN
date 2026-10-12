import { randomBytes } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { SIGN_IN_ACCOUNT, SKIP_REASON, ensureAccount, recoveryToken, staffEnv } from './staff';

/*
 * Sign-in v2 with a real account (Admin v2 F7): the zero-JS form, "Keep me signed in" and
 * a whole password reset, on the local stack. The account is the spec's own
 * (SIGN_IN_ACCOUNT, an SEO): the reset signs it out everywhere, which must never reach the
 * per-role sessions the other admin specs run on. Serial, because the reset changes the
 * password the earlier tests sign in with.
 *
 * The screens without an account (zero JS, the one failure message, "Not set up") are in
 * tests/e2e/admin-sign-in.e2e.ts; the endpoints' guards in tests/authz/{login,recovery}.spec.ts.
 */

const env = staffEnv();
// As in staff.setup.ts: the e2e job always provides the local stack, so in CI a null env
// fails here rather than skipping; locally, skipping is the safe default.
test.skip(!env && !process.env['CI'], SKIP_REASON);
test.describe.configure({ mode: 'serial' });

const SESSION = /^__Host-braiin-auth(\.\d+)?$/;
const SESSION_ONLY = '__Host-braiin-session-only';
const SEVEN_DAYS = 7 * 24 * 60 * 60;

let password = '';

test.beforeAll(async () => {
  expect(env, `CI must run the admin harness: ${SKIP_REASON}`).not.toBeNull();
  ({ password } = await ensureAccount(env!, SIGN_IN_ACCOUNT));
});

async function signIn(page: Page, secret: string, options: { remember?: boolean } = {}) {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(SIGN_IN_ACCOUNT.email);
  await page.getByLabel('Password', { exact: true }).fill(secret);
  if (options.remember === false) await page.getByLabel('Keep me signed in').uncheck();
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function sessionCookies(context: BrowserContext) {
  return (await context.cookies()).filter((cookie) => SESSION.test(cookie.name));
}

test('signs in without JavaScript, kept for 7 days by default', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await signIn(page, password);
  await page.waitForURL((url) => url.pathname === '/admin');

  const cookies = await sessionCookies(context);
  expect(cookies.length).toBeGreaterThan(0);
  const now = Date.now() / 1000;
  for (const cookie of cookies) {
    expect(cookie, cookie.name).toMatchObject({ httpOnly: true, secure: true, path: '/' });
    expect(cookie.sameSite).toBe('Lax');
    // Max-Age 7 days (not @supabase/ssr's 400): an expiry seven days out, give or take.
    expect(cookie.expires - now).toBeGreaterThan(SEVEN_DAYS - 300);
    expect(cookie.expires - now).toBeLessThan(SEVEN_DAYS + 300);
  }
  expect((await context.cookies()).map((c) => c.name)).not.toContain(SESSION_ONLY);
  await context.close();
});

test('unticked, the session ends when the browser closes (session cookies)', async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await signIn(page, password, { remember: false });
  await page.waitForURL((url) => url.pathname === '/admin');

  const cookies = await sessionCookies(context);
  expect(cookies.length).toBeGreaterThan(0);
  for (const cookie of cookies) expect(cookie.expires, cookie.name).toBe(-1);
  const marker = (await context.cookies()).find((c) => c.name === SESSION_ONLY);
  expect(marker).toMatchObject({ value: '1', expires: -1, httpOnly: true, secure: true });

  // A later page keeps it a session cookie (a token refresh rewrites it the same way).
  await page.goto('/admin/analytics');
  for (const cookie of await sessionCookies(context)) expect(cookie.expires).toBe(-1);
  await context.close();
});

test('goes on to where the person was going, never off the admin', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('/admin/analytics');
  await page.waitForURL((url) => url.pathname === '/admin/login');
  await page.getByLabel('Email').fill(SIGN_IN_ACCOUNT.email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => url.pathname === '/admin/analytics');
  await context.close();
});

test('a reset link sets a new password and signs the account out everywhere', async ({
  browser,
}) => {
  // A session open before the reset, on another device.
  const witness = await browser.newContext();
  const witnessPage = await witness.newPage();
  await signIn(witnessPage, password);
  await witnessPage.waitForURL((url) => url.pathname === '/admin');

  const fresh = `${randomBytes(18).toString('base64url')} f7`;
  const token = await recoveryToken(env!, SIGN_IN_ACCOUNT.email);
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const link = `/admin/reset?token_hash=${token}&type=recovery`;

  // Two different passwords: refused before the link is spent, so the form comes back.
  await page.goto(link);
  await page.getByLabel('New password', { exact: true }).fill(fresh);
  await page.getByLabel('Confirm new password', { exact: true }).fill(`${fresh}!`);
  await page.getByRole('button', { name: 'Save new password' }).click();
  await page.waitForURL((url) => url.searchParams.get('error') === 'mismatch');
  await expect(page.getByRole('alert')).toHaveText('The two passwords do not match.');
  expect(new URL(page.url()).searchParams.get('token_hash')).toBe(token);

  await page.getByLabel('New password', { exact: true }).fill(fresh);
  await page.getByLabel('Confirm new password', { exact: true }).fill(fresh);
  await page.getByRole('button', { name: 'Save new password' }).click();
  await page.waitForURL((url) => url.pathname === '/admin/login');
  expect(new URL(page.url()).searchParams.get('reset')).toBe('done');
  await expect(page.getByRole('status')).toContainText('Your password is changed');

  // Signed out everywhere: the other device is sent to sign in.
  await witnessPage.goto('/admin');
  await witnessPage.waitForURL((url) => url.pathname === '/admin/login');
  await witness.close();

  // The old password is refused; the new one works.
  await signIn(page, password);
  await page.waitForURL((url) => url.searchParams.get('error') === 'invalid');
  password = fresh;
  await signIn(page, password);
  await page.waitForURL((url) => url.pathname === '/admin');

  // The link is spent: opening it again offers a new one.
  const again = await browser.newContext({ javaScriptEnabled: false });
  const second = await again.newPage();
  await second.goto(link);
  await second.getByLabel('New password', { exact: true }).fill(`${fresh} again`);
  await second.getByLabel('Confirm new password', { exact: true }).fill(`${fresh} again`);
  await second.getByRole('button', { name: 'Save new password' }).click();
  await second.waitForURL((url) => url.searchParams.get('error') === 'expired');
  await expect(second.getByRole('link', { name: 'Ask for a new link' })).toBeVisible();
  await again.close();
  await context.close();
});
