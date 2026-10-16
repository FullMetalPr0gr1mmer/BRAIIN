import AxeBuilder from '@axe-core/playwright';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  PROFILE_WITH_SETTING,
  SESSION_LOG_SOURCE,
  SETTING_MISSHAPEN,
  SETTING_UNREADABLE,
} from '@/lib/auth/sessionSetting';
import { SKIP_REASON, STAFF_IDS, authFile, ensureAccount, staffEmail, staffEnv } from './staff';

// Users & roles v2 (Admin v2 U12a) in a real browser, signed in as the Admin: the people
// table with e-mails, the read-only role matrix in its own scroll region, the edit drawer and
// both confirms with axe and no sideways scroll at 320, 390 and 1280, the Security card's save
// and its stale-version refusal, the session-length embed through the real PostgREST, and the
// session posture end to end: a throwaway account signs in in a second browser, its access
// token is read off its cookie and pinned to the shape resolveAuthContext relies on (the
// claims' role and tenant, a password `amr` with a time), then the Admin changes its role and
// its next click lands on the sign-in page (0055 deleted its sessions).
//
// Serial, with the accounts made once: the tests share this file's throwaway accounts and the
// tenant's one Security row. The role accounts every other spec runs on are never changed
// here: a role change ends every session of that person, and their saved sessions are shared
// by the whole run.

test.skip(!staffEnv(), SKIP_REASON);
test.describe.configure({ mode: 'serial' });
test.use({ contextOptions: { reducedMotion: 'reduce' }, storageState: authFile('admin') });

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const WIDTHS = [320, 390, 1280] as const;

/** Accounts of this spec alone (fixed ids keep a re-run idempotent). */
const MOVED = {
  id: 'e2e00000-0000-4000-8000-0000000012a1',
  email: 'e2e-u12-moved@example.com',
  role: 'content_creator' as const,
  displayName: 'E2E Moved',
};
const EDITED = {
  id: 'e2e00000-0000-4000-8000-0000000012a2',
  email: 'e2e-u12-edited@example.com',
  role: 'seo' as const,
  displayName: 'E2E Edited',
};
/** An active Admin the (pretended) owner may hand ownership to. */
const NEXT_OWNER = {
  id: 'e2e00000-0000-4000-8000-0000000012a3',
  email: 'e2e-u12-next-owner@example.com',
  role: 'admin' as const,
  displayName: 'E2E Next Owner',
};

let movedPassword = '';

test.beforeAll(async () => {
  const env = staffEnv()!;
  await ensureAccount(env, EDITED);
  await ensureAccount(env, NEXT_OWNER);
  movedPassword = (await ensureAccount(env, MOVED)).password;
});

async function ready(page: Page, path = '/admin/users') {
  await page.goto(path, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
}

async function expectNoAxeViolations(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(
    violations.map((v) => `${v.id} [${v.impact ?? 'n/a'}] ${v.nodes.length}x: ${v.help}`),
    label,
  ).toEqual([]);
}

/** No sideways scroll: the page, and the body of whatever dialog is open. */
async function expectNoOverflow(page: Page, label: string) {
  const sideways = await page.evaluate(() => {
    const page = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const bodies = [...document.querySelectorAll('dialog[open] .drw__b, dialog[open] .mdl__b')]
      .map((body) => body.scrollWidth - body.clientWidth)
      .concat([0]);
    return Math.max(page, ...bodies);
  });
  expect(sideways, `${label}: no sideways scroll`).toBeLessThanOrEqual(1);
}

async function expectClean(page: Page, label: string) {
  await expectNoOverflow(page, label);
  await expectNoAxeViolations(page, label);
}

/** Opens a person's edit drawer: focus arms the row's hidden action at once (the kit's rule). */
async function openEdit(page: Page, name: string) {
  const edit = page.getByRole('button', { name: `Edit ${name}`, exact: true });
  await edit.focus();
  await edit.click();
}

async function csrf(page: Page): Promise<string> {
  const token = await page.locator('meta[name="csrf-token"]').getAttribute('content');
  expect(token).toBeTruthy();
  return token!;
}

/** The access token in a context's session cookie (@supabase/ssr: `base64-` + base64url JSON, maybe chunked). */
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

async function signInElsewhere(
  browser: Browser,
  account: { email: string; password: string },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => url.pathname === '/admin');
  return { context, page };
}

test('the screen: people with e-mails and the role matrix, clean at 320, 390 and 1280', async ({
  page,
}) => {
  await ready(page);
  const table = page.getByRole('table', { name: 'People who can use the admin' });
  await expect(table).toBeVisible();
  // E-mails come from public.staff_accounts (a live Admin only).
  await expect(table.getByText(staffEmail('seo'))).toBeVisible();
  await expect(table.getByText('(you)')).toBeVisible();

  const matrix = page.getByRole('region', { name: 'What each role can do' });
  await expect(matrix).toBeVisible();
  await expect(matrix).toHaveAttribute('tabindex', '0');
  await expect(
    page.getByText('Roles are fixed and checked twice, on the server and in the database.'),
  ).toBeVisible();
  await expect(
    matrix.getByRole('rowheader', { name: 'Invite people and change their roles' }),
  ).toBeVisible();

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await expectClean(page, `the users screen at ${width}px`);
  }
});

test('the drawer and both confirms: axe and no sideways scroll at 320, 390 and 1280', async ({
  page,
}) => {
  // "Make account owner" shows only to the owner. The harness cannot mark one (only an
  // operator can, runbook §3a), so the list the screen loads says the Admin is the owner;
  // the confirm is opened and cancelled, never sent.
  await page.route('**/api/admin/users?*', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { data: { rows: Record<string, unknown>[] } };
    body.data.rows = body.data.rows.map((row) =>
      row['id'] === STAFF_IDS.admin ? { ...row, isOwner: true } : row,
    );
    await route.fulfill({ response, json: body });
  });

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await ready(page);

    await openEdit(page, EDITED.displayName);
    const drawer = page.getByRole('dialog', { name: 'Edit user' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText(EDITED.email)).toBeVisible();
    await drawer.getByLabel('Role').selectOption('developer');
    await expect(drawer.getByText('A role change signs them out on every device.')).toBeVisible();
    await expectClean(page, `the edit drawer at ${width}px`);
    await drawer.getByLabel('Role').selectOption(EDITED.role);

    await drawer.getByRole('button', { name: 'Remove access' }).click();
    const remove = page.getByRole('dialog', { name: `Remove access for ${EDITED.displayName}?` });
    await expect(remove).toBeVisible();
    await expect(
      remove.getByText('They are signed out and cannot sign in again until you re-enable them.'),
    ).toBeVisible();
    await expectClean(page, `the remove-access confirm at ${width}px`);
    await remove.getByRole('button', { name: 'Cancel' }).click();
    await expect(remove).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();

    await openEdit(page, NEXT_OWNER.displayName);
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: 'Make account owner' }).click();
    const owner = page.getByRole('dialog', {
      name: `Make ${NEXT_OWNER.displayName} the account owner?`,
    });
    await expect(owner).toBeVisible();
    await expectClean(page, `the make-owner confirm at ${width}px`);
    await owner.getByRole('button', { name: 'Cancel' }).click();
    await expect(owner).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
  }
});

test('the Security card saves, and a save over someone else’s change is refused (409)', async ({
  page,
}) => {
  await ready(page);
  const card = page.locator('section.card', {
    has: page.getByRole('heading', { name: 'Security' }),
  });
  const restore = async () => {
    const current = await page.request.get('/api/admin/users/security');
    const { data } = (await current.json()) as { data: { version: number } };
    await page.request.put('/api/admin/users/security', {
      headers: { 'x-csrf-token': await csrf(page), origin: new URL(page.url()).origin },
      data: { sessionMaxDays: 7, inviteDomain: null, version: data.version },
    });
  };
  try {
    await card.getByRole('radio', { name: '1 day' }).check();
    await card.getByLabel('Allowed email domain').fill('Example.com');
    await card.getByRole('button', { name: 'Save' }).click();
    await expect(card.getByRole('status')).toHaveText(/^Saved/);
    await expect(card.getByLabel('Allowed email domain')).toHaveValue('example.com');

    // Someone else saves in between (the API, as another tab would).
    const current = await page.request.get('/api/admin/users/security');
    const { data } = (await current.json()) as { data: { version: number } };
    const other = await page.request.put('/api/admin/users/security', {
      headers: { 'x-csrf-token': await csrf(page), origin: new URL(page.url()).origin },
      data: { sessionMaxDays: 1, inviteDomain: null, version: data.version },
    });
    expect(other.status()).toBe(200);

    await card.getByRole('radio', { name: '7 days' }).check();
    await card.getByRole('button', { name: 'Save' }).click();
    await expect(card.getByRole('alert')).toHaveText(
      'Someone else changed these settings. Reload the page to see their version.',
    );
  } finally {
    await restore();
  }
});

test('a role change signs the person out: the next click lands on the sign-in page', async ({
  page,
  browser,
}) => {
  const elsewhere = await signInElsewhere(browser, { email: MOVED.email, password: movedPassword });
  try {
    // The token GoTrue issued, as resolveAuthContext reads it (src/lib/auth/claims.ts): the
    // hook's role and tenant in app_metadata, and a password sign-in with its time in amr.
    const claims = claimsOf(await accessTokenOf(elsewhere.context));
    expect(claims['sub']).toBe(MOVED.id);
    expect(claims['app_metadata']).toMatchObject({ role: MOVED.role });
    expect(typeof (claims['app_metadata'] as Record<string, unknown>)['tenant_id']).toBe('string');
    expect(claims['amr']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'password', timestamp: expect.any(Number) }),
      ]),
    );
    const signedIn = (claims['amr'] as { timestamp: number }[])[0]!.timestamp;
    expect(Math.abs(Date.now() / 1000 - signedIn)).toBeLessThan(600);

    // The Admin changes the role, through the users screen.
    await ready(page);
    await openEdit(page, MOVED.displayName);
    const drawer = page.getByRole('dialog', { name: 'Edit user' });
    await drawer.getByLabel('Role').selectOption('seo');
    await drawer.getByRole('button', { name: 'Save' }).click();
    await expect(
      page.getByText(`Saved. ${MOVED.displayName} is signed out on every device`),
    ).toBeVisible();

    // Their next click: no session (0055 deleted it), so the sign-in page.
    await elsewhere.page.goto('/admin');
    await expect(elsewhere.page).toHaveURL(/\/admin\/login/);
  } finally {
    await elsewhere.context.close();
  }
});

test('the session length is read through the real embed, and never fell back', async () => {
  // The unit tests mock PostgREST; this runs the session check's own select against the local
  // one, as the service role, and expects the shape it relies on: a tenant holding a
  // `security` key. Then, after every request this file made, no isolate logged that the
  // embed failed or came back misshapen (each would mean the 7-day default was applied).
  const env = staffEnv()!;
  const svc = createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await svc
    .from('profiles')
    .select(PROFILE_WITH_SETTING)
    .eq('id', STAFF_IDS.admin)
    .maybeSingle<{ tenant: unknown }>();
  expect(error, error?.message).toBeNull();
  const tenant = (Array.isArray(data?.tenant) ? data?.tenant[0] : data?.tenant) as
    Record<string, unknown> | null | undefined;
  expect(tenant && typeof tenant === 'object' && 'security' in tenant).toBe(true);

  const { count, error: logError } = await svc
    .from('system_logs')
    .select('id', { count: 'exact', head: true })
    .eq('source', SESSION_LOG_SOURCE)
    .in('message', [SETTING_UNREADABLE, SETTING_MISSHAPEN]);
  expect(logError, logError?.message).toBeNull();
  expect(count).toBe(0);
});
