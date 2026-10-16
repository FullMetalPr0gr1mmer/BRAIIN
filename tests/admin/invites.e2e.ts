import { randomBytes } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { TENANT_ID } from '../../scripts/gen-seeds.mjs';
import { SKIP_REASON, authFile, staffEnv } from './staff';

// Invites (Admin v2 U12b) in a real browser, signed in as the Admin, on the local stack:
//
//   - switched off while the site cannot send e-mail (the CI preview is built with
//     AUTH_EMAIL_READY off until owner item O-2): Invite someone and Resend say "Not set up",
//     and the API answers 503 `not-set-up` even when the screen is made to offer them;
//   - the invite drawer and the Cancel confirm with axe and no sideways scroll at 320, 390
//     and 1280 (the drawer is reached by rewriting the page's `emailReady` prop, as a
//     switched-on build would render it; its send is still refused by the server);
//   - Cancel removes an invite nobody accepted;
//   - Resend's call (decision D8): GoTrue's invite, made again for an account invited and not
//     yet joined, sends it a fresh link on the same account (its mail goes to the local
//     stack's mail catcher), and the first link stops working;
//   - a whole acceptance: the invite link (from GoTrue's admin API, which sends no e-mail;
//     the local stack has no SMTP to speak of) opens /admin/invite with JavaScript off, the
//     password is set, the person signs in with it in the role chosen, the acceptance is
//     audited without the address, and Cancel is refused from then on.
//
// The invited accounts are this spec's own, made as POST /api/admin/users makes them (the
// invite, app_metadata, the profile). GoTrue picks their ids, so a re-run first removes any
// account left at the same address.

const env = staffEnv();
test.skip(!env, SKIP_REASON);
test.describe.configure({ mode: 'serial' });
test.use({ contextOptions: { reducedMotion: 'reduce' }, storageState: authFile('admin') });

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const WIDTHS = [320, 390, 1280] as const;

const TO_CANCEL = { email: 'e2e-u12b-cancel@example.com', role: 'content_creator' as const };
const TO_ACCEPT = { email: 'e2e-u12b-accept@example.com', role: 'seo' as const };
const TO_RESEND = { email: 'e2e-u12b-resend@example.com', role: 'developer' as const };

function service(): SupabaseClient {
  return createClient(env!.url, env!.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Removes any account at this address (a previous run's), its profile cascading. */
async function removeByEmail(svc: SupabaseClient, email: string) {
  const { data, error } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(`list users: ${error.message}`);
  for (const user of data.users.filter((u) => u.email?.toLowerCase() === email)) {
    const { error: deleteError } = await svc.auth.admin.deleteUser(user.id);
    if (deleteError) throw new Error(`remove ${email}: ${deleteError.message}`);
  }
}

/**
 * An invite, as the users screen's POST makes one, without the e-mail: GoTrue's invite link
 * (the account invited and unconfirmed), the role and tenant in app_metadata, the profile.
 * Returns the account's id and the link's token hash.
 */
async function invite(account: {
  email: string;
  role: string;
}): Promise<{ id: string; token: string }> {
  const svc = service();
  await removeByEmail(svc, account.email);
  const { data, error } = await svc.auth.admin.generateLink({
    type: 'invite',
    email: account.email,
  });
  const id = data?.user?.id;
  const token = data?.properties?.hashed_token;
  if (error || !id || !token)
    throw new Error(`invite ${account.email}: ${error?.message ?? 'none'}`);
  const { error: metaError } = await svc.auth.admin.updateUserById(id, {
    app_metadata: { role: account.role, tenant_id: TENANT_ID },
  });
  if (metaError) throw new Error(`invite ${account.email} metadata: ${metaError.message}`);
  const { error: profileError } = await svc.from('profiles').insert({
    id,
    tenant_id: TENANT_ID,
    role: account.role,
    is_active: true,
    display_name: null,
  });
  if (profileError) throw new Error(`invite ${account.email} profile: ${profileError.message}`);
  return { id, token };
}

async function ready(page: Page) {
  await page.goto('/admin/users', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
}

async function expectClean(page: Page, label: string) {
  const sideways = await page.evaluate(() => {
    const root = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const bodies = [...document.querySelectorAll('dialog[open] .drw__b, dialog[open] .mdl__b')]
      .map((body) => body.scrollWidth - body.clientWidth)
      .concat([0]);
    return Math.max(root, ...bodies);
  });
  expect(sideways, `${label}: no sideways scroll`).toBeLessThanOrEqual(1);
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(
    violations.map((v) => `${v.id} [${v.impact ?? 'n/a'}] ${v.nodes.length}x: ${v.help}`),
    label,
  ).toEqual([]);
}

async function csrf(page: Page): Promise<string> {
  const token = await page.locator('meta[name="csrf-token"]').getAttribute('content');
  expect(token).toBeTruthy();
  return token!;
}

function pendingCard(page: Page) {
  return page.locator('section.card', {
    has: page.getByRole('heading', { name: 'Pending invites' }),
  });
}

let cancelId = '';
let accept = { id: '', token: '' };
let resent = { id: '', token: '' };

test.beforeAll(async () => {
  const svc = service();
  // The acceptance's own limiter (per address and per tenant, src/lib/auth/recovery.ts):
  // a local re-run would otherwise meet it.
  await svc.from('public_write_attempts').delete().like('scope', 'auth.invite:%');
  cancelId = (await invite(TO_CANCEL)).id;
  accept = await invite(TO_ACCEPT);
  resent = await invite(TO_RESEND);
});

/** Submits a password with this invite token on /admin/invite, JavaScript off, signed out. */
async function submitInvite(browser: Browser, token: string, password: string): Promise<URL> {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    storageState: { cookies: [], origins: [] },
  });
  try {
    const invitee = await context.newPage();
    await invitee.goto(`/admin/invite?token_hash=${token}&type=invite`);
    await invitee.getByLabel('Password', { exact: true }).fill(password);
    await invitee.getByLabel('Confirm password', { exact: true }).fill(password);
    await invitee.getByRole('button', { name: 'Set password' }).click();
    // The form's answer is a 303: back to the page with an error code, or to the login page.
    // (The page it leaves carries the token and no code, so neither matches it.)
    await invitee.waitForURL(
      (url) => url.searchParams.has('error') || url.pathname === '/admin/login',
    );
    return new URL(invitee.url());
  } finally {
    await context.close();
  }
}

test('pending invites are listed; while e-mail is off, invites and resends are Not set up', async ({
  page,
}) => {
  await ready(page);
  const card = pendingCard(page);
  await expect(card.getByText(TO_CANCEL.email)).toBeVisible();
  await expect(card.getByText(TO_ACCEPT.email)).toBeVisible();

  const inviteButton = card.getByRole('button', { name: 'Invite someone' });
  const resend = card.getByRole('button', { name: `Resend the invite to ${TO_CANCEL.email}` });
  if (await inviteButton.isEnabled()) {
    // A build with e-mail set up (after O-2): nothing here is switched off.
    await expect(resend).toBeEnabled();
    return;
  }
  await expect(card.getByText('Not set up', { exact: true })).toBeVisible();
  await expect(card.getByText('Email delivery is not connected yet')).toBeVisible();
  await expect(resend).toBeDisabled();
  await expect(
    card.getByRole('button', { name: `Cancel the invite to ${TO_CANCEL.email}` }),
  ).toBeEnabled();

  // The server says the same, whatever the screen offers.
  const headers = { 'x-csrf-token': await csrf(page), origin: new URL(page.url()).origin };
  const sent = await page.request.post('/api/admin/users', {
    headers,
    data: { email: 'e2e-u12b-never@example.com', role: 'seo' },
  });
  expect(sent.status()).toBe(503);
  expect(await sent.json()).toMatchObject({ ok: false, error: 'not-set-up' });
  const again = await page.request.post(`/api/admin/users/${cancelId}/resend`, {
    headers,
    data: {},
  });
  expect(again.status()).toBe(503);
});

test('the invite drawer and the Cancel confirm: axe and no sideways scroll at 320, 390 and 1280', async ({
  page,
}) => {
  // Render the screen as a build with e-mail set up would (the island's emailReady prop),
  // so the drawer can be opened; the server still refuses the send while it is off.
  let rewritten = false;
  await page.route(
    (url) => url.pathname === '/admin/users',
    async (route) => {
      const response = await route.fetch();
      const html = await response.text();
      const on = html.replace(/(&quot;emailReady&quot;:\[0,)false\]/, '$1true]');
      rewritten ||= on !== html;
      await route.fulfill({ response, body: on });
    },
  );

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await ready(page);
    const card = pendingCard(page);

    await card.getByRole('button', { name: 'Invite someone' }).click();
    const drawer = page.getByRole('dialog', { name: 'Invite someone' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('The link works for one hour.')).toBeVisible();
    await drawer.getByLabel('Email').fill('e2e-u12b-drawer@example.com');
    await drawer.getByLabel('Message (optional)').fill('Welcome aboard.');
    await expectClean(page, `the invite drawer at ${width}px`);
    if (rewritten) {
      // Off at the server: the drawer says so, and nothing is sent.
      await drawer.getByRole('button', { name: 'Send invite' }).click();
      await expect(drawer.getByRole('alert')).toContainText('Not set up yet');
    }
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();

    await card.getByRole('button', { name: `Cancel the invite to ${TO_CANCEL.email}` }).click();
    const confirm = page.getByRole('dialog', { name: 'Cancel invite?' });
    await expect(confirm).toBeVisible();
    await expect(
      confirm.getByText(`${TO_CANCEL.email} will not be able to join with this link.`),
    ).toBeVisible();
    await expectClean(page, `the cancel confirm at ${width}px`);
    await confirm.getByRole('button', { name: 'Keep invite' }).click();
    await expect(confirm).toBeHidden();
  }
});

test('Cancel removes an invite nobody accepted', async ({ page }) => {
  await ready(page);
  const card = pendingCard(page);
  await card.getByRole('button', { name: `Cancel the invite to ${TO_CANCEL.email}` }).click();
  const confirm = page.getByRole('dialog', { name: 'Cancel invite?' });
  await confirm.getByRole('button', { name: 'Cancel invite' }).click();
  await expect(page.getByText(`Invite cancelled. ${TO_CANCEL.email} cannot join`)).toBeVisible();
  await expect(card.getByText(TO_CANCEL.email)).toBeHidden();

  const { data } = await service().auth.admin.getUserById(cancelId);
  expect(data.user).toBeNull();
});

test('Resend (D8): GoTrue sends a pending invite a fresh link, and the first one stops working', async ({
  browser,
  baseURL,
}) => {
  const svc = service();
  const { data: first, error: firstError } = await svc.auth.admin.getUserById(resent.id);
  expect(firstError, firstError?.message).toBeNull();
  const invitedAt = first.user?.invited_at;
  expect(invitedAt).toBeTruthy();

  // The call POST /api/admin/users/[id]/resend makes (src/pages/api/admin/users/[id]/resend.ts),
  // made directly: the CI preview is built with e-mail off, so the route itself answers 503.
  // GoTrue really sends here (the local stack's mail catcher), as it would after O-2.
  const { data, error } = await svc.auth.admin.inviteUserByEmail(TO_RESEND.email, {
    redirectTo: new URL('/admin/invite', baseURL).toString(),
  });
  expect(error, error?.message).toBeNull();
  expect(data.user?.id).toBe(resent.id);

  const { data: again } = await svc.auth.admin.getUserById(resent.id);
  expect(Date.parse(again.user?.invited_at ?? '')).toBeGreaterThan(Date.parse(invitedAt!));
  expect(again.user?.email_confirmed_at ?? null).toBeNull();

  // The first link no longer verifies: the page says it is not valid, and the account is
  // still an unaccepted invite (nothing confirmed, no password set).
  const landed = await submitInvite(
    browser,
    resent.token,
    `${randomBytes(18).toString('base64url')} d8`,
  );
  expect(landed.pathname).toBe('/admin/invite');
  expect(landed.searchParams.get('error')).toBe('expired');
  const { data: after } = await svc.auth.admin.getUserById(resent.id);
  expect(after.user?.email_confirmed_at ?? null).toBeNull();
  expect(after.user?.last_sign_in_at ?? null).toBeNull();

  // Tidy: the screen's later sweeps should not meet this account.
  const { error: deleteError } = await svc.auth.admin.deleteUser(resent.id);
  expect(deleteError, deleteError?.message).toBeNull();
});

test('an invite link sets the password, the person signs in, and Cancel is refused after', async ({
  page,
  browser,
}) => {
  const password = `${randomBytes(18).toString('base64url')} u12b`;
  const context = await browser.newContext({
    javaScriptEnabled: false,
    storageState: { cookies: [], origins: [] },
  });
  try {
    const invitee = await context.newPage();
    await invitee.goto(`/admin/invite?token_hash=${accept.token}&type=invite`);
    await expect(invitee.getByRole('heading', { name: 'Set your password' })).toBeVisible();

    // Two different passwords: refused before the link is spent, and it comes back in the
    // page's own cookie, never the URL.
    await invitee.getByLabel('Password', { exact: true }).fill(password);
    await invitee.getByLabel('Confirm password', { exact: true }).fill(`${password}!`);
    await invitee.getByRole('button', { name: 'Set password' }).click();
    await invitee.waitForURL((url) => url.searchParams.get('error') === 'mismatch');
    expect(invitee.url()).not.toContain(accept.token);
    await expect(invitee.locator('input[type="hidden"][name="token_hash"]')).toHaveValue(
      accept.token,
    );

    await invitee.getByLabel('Password', { exact: true }).fill(password);
    await invitee.getByLabel('Confirm password', { exact: true }).fill(password);
    await invitee.getByRole('button', { name: 'Set password' }).click();
    await invitee.waitForURL((url) => url.pathname === '/admin/login');
    expect(new URL(invitee.url()).searchParams.get('invite')).toBe('ready');
    await expect(invitee.getByRole('status')).toContainText('Your password is set');
    expect((await context.cookies()).map((c) => c.name)).not.toContain('__Secure-braiin-invite');

    await invitee.getByLabel('Email').fill(TO_ACCEPT.email);
    await invitee.getByLabel('Password', { exact: true }).fill(password);
    await invitee.getByRole('button', { name: 'Sign in' }).click();
    await invitee.waitForURL((url) => url.pathname === '/admin');

    // The link is spent.
    await invitee.goto(`/admin/invite?token_hash=${accept.token}&type=invite`);
    await invitee.getByLabel('Password', { exact: true }).fill(`${password} again`);
    await invitee.getByLabel('Confirm password', { exact: true }).fill(`${password} again`);
    await invitee.getByRole('button', { name: 'Set password' }).click();
    await invitee.waitForURL((url) => url.searchParams.get('error') === 'expired');
  } finally {
    await context.close();
  }

  // The role chosen, and the acceptance audited against the account, without the address.
  const svc = service();
  const { data: profile } = await svc
    .from('profiles')
    .select('role')
    .eq('id', accept.id)
    .maybeSingle<{ role: string }>();
  expect(profile?.role).toBe(TO_ACCEPT.role);
  const { data: rows, error } = await svc
    .from('audit_log')
    .select('action,detail')
    .eq('entity_id', accept.id)
    .eq('action', 'auth.invite_accepted');
  expect(error, error?.message).toBeNull();
  expect(rows ?? []).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain(TO_ACCEPT.email);

  // Joined: no longer pending, and neither Cancel nor Resend applies.
  await ready(page);
  await expect(pendingCard(page).getByText(TO_ACCEPT.email)).toBeHidden();
  const cancel = await page.request.delete(`/api/admin/users/${accept.id}/invite`, {
    headers: { 'x-csrf-token': await csrf(page), origin: new URL(page.url()).origin },
  });
  expect(cancel.status()).toBe(422);
});
