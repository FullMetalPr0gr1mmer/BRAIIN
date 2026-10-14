import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { staffEnv } from '../admin/staff';

// The sign-in screens as a visitor with no session meets them (Admin v2 F7): sign in,
// forgot password, reset password. No account is needed for anything here; signing in,
// "Keep me signed in" and a whole reset run signed in, in tests/admin/signin.e2e.ts.
//
//   - zero JavaScript on all three (the login page used to download the admin's scripts);
//   - the design's parts: "Welcome back", "Keep me signed in" ticked by default (owner
//     item O-14), "Forgot password?";
//   - the no-JS form posts and comes back with one message for every failed sign-in;
//   - forgot says "Not set up" while e-mail is off (owner item O-2), and otherwise answers
//     a known and an unknown address alike, through the no-JS form; its API, the same. The
//     CI preview is built with e-mail off until O-2 turns it on (AUTH_EMAIL_READY in
//     wrangler.jsonc, which the CI build reads too); the set-up screen's markup is rendered
//     by tests/render/authPages.spec.ts meanwhile;
//   - a reset link without a usable token offers a new one instead of a form;
//   - a sign-in form post the CSRF check refuses goes back to its page with a message (a
//     tab restored after a browser restart has lost its token), never to a JSON page.

const TOKEN = 'a1b2c3d4'.repeat(7);
const SCREENS = ['/admin/login', '/admin/forgot', `/admin/reset?token_hash=${TOKEN}&type=recovery`];

for (const path of SCREENS) {
  test(`${path.split('?')[0]} loads no JavaScript`, async ({ page }) => {
    const scripts: string[] = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'script') scripts.push(request.url());
    });
    await page.goto(path, { waitUntil: 'load' });
    expect(scripts).toEqual([]);
    expect(await page.locator('script').count()).toBe(0);
  });
}

test('sign in: the design, with "Keep me signed in" ticked by default', async ({ page }) => {
  await page.goto('/admin/login');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome back');
  await expect(page.getByLabel('Email')).toHaveAttribute('autocomplete', 'username');
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute(
    'autocomplete',
    'current-password',
  );
  await expect(page.getByLabel('Keep me signed in')).toBeChecked();
  await expect(page.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute(
    'href',
    '/admin/forgot',
  );
  // The brand is the logo's text alternative, from site_profile; it is never typed here.
  await expect(page.locator('img.login__logo')).not.toHaveAttribute('alt', '');
});

/**
 * Empties the forgot limiter's windows on the LOCAL stack (staffEnv: loopback Supabase and
 * preview, the service key, a build against that Supabase), as apply-roundtrip.e2e.ts does
 * for its own. The test below posts four times from one address and twice for one e-mail,
 * within the 5 and 3 an hour (src/lib/auth/recovery.ts), but CI's retry, or a local
 * re-run, would go past them and the two answers would differ for that reason alone.
 */
async function clearForgotLimits(): Promise<void> {
  const env = staffEnv();
  if (!env) return;
  const svc = createClient(env.url, env.serviceKey, { auth: { persistSession: false } });
  const { error } = await svc.from('public_write_attempts').delete().like('scope', 'auth.forgot:%');
  expect(error).toBeNull();
}

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('forgot password never says which addresses have an account', async ({ page }) => {
    await page.goto('/admin/forgot');
    const notSetUp = (await page.getByText('Not set up', { exact: true }).count()) > 0;
    const origin = new URL(page.url()).origin;
    const csrf = (await page.context().cookies()).find((c) => c.name === '__Host-csrf')?.value;
    expect(csrf).toBeTruthy();

    if (notSetUp) {
      // E-mail is off (owner item O-2, the CI stack's state): no form pretends to send.
      await expect(page.getByLabel('Email')).toHaveCount(0);
      await expect(page.getByRole('status')).toContainText('cannot send password emails');
    } else {
      await clearForgotLimits();
      const shown: string[] = [];
      for (const email of ['e2e-admin@example.com', 'nobody-f7@example.com']) {
        await page.goto('/admin/forgot');
        await page.getByLabel('Email').fill(email);
        await page.getByRole('button', { name: 'Send reset link' }).click();
        await page.waitForURL((url) => url.searchParams.has('status'));
        expect(page.url()).not.toContain('example.com');
        shown.push(`${page.url()} ${await page.getByRole('status').innerText()}`);
      }
      expect(shown[0]).toBe(shown[1]);
      expect(shown[0]).toContain('/admin/forgot?status=sent');
    }

    // The API: the same status and body for a staff address and an unknown one.
    const answers: string[] = [];
    for (const email of ['e2e-admin@example.com', 'nobody-f7@example.com']) {
      const res = await page.request.post('/api/admin/auth/forgot', {
        headers: { 'x-csrf-token': csrf ?? '', origin },
        data: { email },
      });
      answers.push(`${res.status()} ${await res.text()}`);
    }
    expect(answers[0]).toBe(answers[1]);
    if (notSetUp) expect(answers[0]).toBe('503 {"ok":false,"error":"not-set-up"}');
  });

  test('a failed sign-in comes back with the one message, whatever failed', async ({ page }) => {
    const answers: string[] = [];
    for (const [email, password] of [
      ['nobody-f7@example.com', 'not the password'],
      ['someone-else-f7@example.com', 'another wrong one'],
    ] as const) {
      await page.goto('/admin/login?next=%2Fadmin%2Fusers');
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL((url) => url.searchParams.has('error'));
      const url = new URL(page.url());
      expect(url.pathname).toBe('/admin/login');
      // Where the person was going survives; what they typed is never in the URL.
      expect(url.searchParams.get('next')).toBe('/admin/users');
      expect(page.url()).not.toContain('example.com');
      answers.push(`${url.search} ${await page.getByRole('alert').innerText()}`);
    }
    expect(answers[0]).toBe(answers[1]);
    expect(answers[0]).toContain('Those credentials did not work.');
  });

  test('a sign-in page open past its token comes back with a message, not a JSON page', async ({
    page,
    context,
  }) => {
    await page.goto('/admin/login?next=%2Fadmin%2Fusers');
    // What a browser restart does to a tab it restores: the session cookie with the token
    // the page carries is gone.
    await context.clearCookies({ name: '__Host-csrf' });
    await page.getByLabel('Email').fill('nobody-f7@example.com');
    await page.getByLabel('Password', { exact: true }).fill('not the password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => url.searchParams.get('error') === 'expired-form');
    const url = new URL(page.url());
    expect(url.pathname).toBe('/admin/login');
    expect(url.searchParams.get('next')).toBe('/admin/users');
    await expect(page.getByRole('alert')).toHaveText(
      'This page was open too long. Please try again.',
    );
    // The page minted a new token, so the form works again.
    expect((await context.cookies()).map((c) => c.name)).toContain('__Host-csrf');
  });

  test("the reset page's own requests send the origin alone as Referer, not its URL", async ({
    page,
  }) => {
    // The URL carries the e-mail's token; `strict-origin` keeps it out of the form post's and
    // the links' Referer, and, unlike `no-referrer`, still sends the Origin the post needs.
    await page.goto(`/admin/reset?token_hash=${TOKEN}&type=recovery`);
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'strict-origin');
    await page.goto('/admin/login');
    await expect(page.locator('meta[name="referrer"]')).toHaveCount(0);
  });

  test('a reset link with no usable token offers a new one, not a form', async ({ page }) => {
    for (const path of ['/admin/reset', '/admin/reset?token_hash=x&type=recovery']) {
      await page.goto(path);
      await expect(page.getByRole('alert')).toContainText('not valid');
      await expect(page.getByRole('link', { name: 'Ask for a new link' })).toHaveAttribute(
        'href',
        '/admin/forgot',
      );
      await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
    }
  });
});

test('the sign-in endpoints refuse a post without the CSRF token', async ({ page }) => {
  await page.goto('/admin/login');
  const origin = new URL(page.url()).origin;
  for (const [path, back] of [
    ['/api/admin/auth/login', '/admin/login?error=expired-form'],
    ['/api/admin/auth/forgot', '/admin/forgot?status=expired-form'],
    ['/api/admin/auth/reset', '/admin/reset?error=expired-form'],
  ] as const) {
    // A form post (what the zero-JS screens send) goes back to its page with a code the
    // page renders, never to a JSON page; nothing in it is acted on (src/lib/auth/expiredForm.ts).
    const form = await page.request.post(path, {
      form: { email: 'nobody-f7@example.com' },
      headers: { origin },
      maxRedirects: 0,
    });
    expect(form.status(), path).toBe(303);
    const location = new URL(form.headers()['location'] ?? '', origin);
    expect(`${location.pathname}${location.search}`, path).toBe(back);
    // A script's post keeps the JSON 403.
    const json = await page.request.post(path, {
      data: { email: 'nobody-f7@example.com' },
      headers: { origin },
      maxRedirects: 0,
    });
    expect(json.status(), path).toBe(403);
    expect(await json.json(), path).toEqual({ ok: false, error: 'csrf' });
  }
});

test('the sign-in endpoints refuse an oversized body before reading it', async ({ page }) => {
  // Over the pre-auth limit (16 KB, src/lib/auth/bodyLimit.ts), with the right CSRF token:
  // the size is refused first. A form goes back to its page; a script gets a JSON 413.
  await page.goto('/admin/login');
  const origin = new URL(page.url()).origin;
  const csrf = (await page.context().cookies()).find((c) => c.name === '__Host-csrf')?.value;
  expect(csrf).toBeTruthy();
  const pad = 'x'.repeat(17 * 1024);
  const form = await page.request.post('/api/admin/auth/login', {
    form: { _csrf: csrf ?? '', email: 'nobody-f7@example.com', password: 'not it', pad },
    headers: { origin },
    maxRedirects: 0,
  });
  expect(form.status()).toBe(303);
  const location = new URL(form.headers()['location'] ?? '', origin);
  expect(`${location.pathname}${location.search}`).toBe('/admin/login?error=too-large');
  const json = await page.request.post('/api/admin/auth/forgot', {
    data: { email: 'nobody-f7@example.com', pad },
    headers: { origin, 'x-csrf-token': csrf ?? '' },
    maxRedirects: 0,
  });
  expect(json.status()).toBe(413);
  expect(await json.json()).toEqual({ ok: false, error: 'too-large' });
});
