import { expect, test } from '@playwright/test';

// The sign-in screens as a visitor with no session meets them (Admin v2 F7): sign in,
// forgot password, reset password. No account is needed for anything here; signing in,
// "Keep me signed in" and a whole reset run signed in, in tests/admin/signin.e2e.ts.
//
//   - zero JavaScript on all three (the login page used to download the admin's scripts);
//   - the design's parts: "Welcome back", "Keep me signed in" ticked by default (owner
//     item O-14), "Forgot password?";
//   - the no-JS form posts and comes back with one message for every failed sign-in;
//   - forgot says "Not set up" while e-mail is off (owner item O-2), and otherwise answers
//     a known and an unknown address alike; its API, the same;
//   - a reset link without a usable token offers a new one instead of a form.

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

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

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
    const shown: string[] = [];
    for (const email of ['e2e-admin@example.com', 'nobody-f7@example.com']) {
      await page.goto('/admin/forgot');
      await page.getByLabel('Email').fill(email);
      await page.getByRole('button', { name: 'Send reset link' }).click();
      await page.waitForURL((url) => url.searchParams.has('status'));
      shown.push(`${page.url()} ${await page.getByRole('status').innerText()}`);
    }
    expect(shown[0]).toBe(shown[1]);
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

test('the sign-in endpoints refuse a post without the CSRF token', async ({ page }) => {
  await page.goto('/admin/login');
  for (const path of ['/api/admin/auth/login', '/api/admin/auth/forgot', '/api/admin/auth/reset']) {
    const res = await page.request.post(path, { form: { email: 'nobody-f7@example.com' } });
    expect(res.status(), path).toBe(403);
  }
});
