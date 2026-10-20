import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { RECRUITMENT_POLICY_VERSION } from '@consent/recruitment';
import { createApplication } from '@/lib/applications/create';
import { CV_BUCKET } from '@/lib/applications/storage';
import { TENANT_ID } from '../../scripts/gen-seeds.mjs';
import { SKIP_REASON, authFile, staffEnv } from './staff';

/*
 * Job applications on the kit (Admin v2 U8a), signed in as Admin, through the real Worker:
 *   list     at 320, 390 and 1280 px: zero axe violations, no sideways scroll, no CSP
 *            violation; the status chips filter;
 *   ?open    the address opens one application in the drawer (axe with it open);
 *   reveal   one GET that writes exactly one `application.view_pii` row; a status change and a
 *            notes save after it write NO second one, and the revealed values stay on screen
 *            (before U8a every save re-revealed: a second decrypt and audit row per save);
 *   spam     asks first, and Cancel changes nothing;
 *   CV       the link answers an attachment with the sandbox CSP and no-store, and writes one
 *            `application.cv_download` row;
 *   two      a status save for one application, held until a second is open in the drawer,
 *            lands on the first only: the second keeps its name, message and status;
 *   erase    asks first, then the row and the CV object are gone (read as the service role);
 *            the next application opened has its controls on (an erase used to leave them off).
 * The applications are made here with the repo's own writer (createApplication, the CI dummy
 * key the workflows export); the second has no CV. Its name has no `E2E ` prefix: tests/e2e/apply-roundtrip.e2e.ts
 * deletes `name like 'E2E %'` and may run alongside. Whatever remains is erased in afterAll.
 * Non-admins are refused by the server (tests/admin/refusals.e2e.ts, LOCKED_SCREENS).
 */

const env = staffEnv();
const KEY = process.env['LEAD_PII_ENC_KEY'] ?? '';
test.skip(!env || !KEY, SKIP_REASON);
test.describe.configure({ mode: 'serial' });
test.use({ storageState: authFile('admin'), contextOptions: { reducedMotion: 'reduce' } });

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const RUN = Date.now().toString(36);
const NAME = `Drawer Check ${RUN}`;
const EMAIL = `drawer-${RUN}@example.com`;
const PHONE = '+966500000123';
const OTHER = `Drawer Second ${RUN}`;
const OTHER_MESSAGE = 'A second application, opened while the first one saves.';
const PDF = new Blob(['%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'], {
  type: 'application/pdf',
});

let id = '';
let otherId = '';

function service(): SupabaseClient {
  return createClient(env!.url, env!.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function auditCount(action: string): Promise<number> {
  const { count, error } = await service()
    .from('audit_log')
    .select('id', { count: 'exact', head: true })
    .eq('entity_id', id)
    .eq('action', action);
  expect(error, error?.message).toBeNull();
  return count ?? 0;
}

async function ready(page: Page) {
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  await page.waitForLoadState('networkidle');
}

async function axeClean(page: Page, where: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    where,
  ).toEqual([]);
}

async function noSidewaysScroll(page: Page, where: string) {
  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over, `${where}: sideways scroll`).toBeLessThanOrEqual(0);
}

async function watchCsp(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      w.__csp.push(`${event.violatedDirective} ${event.blockedURI || 'inline'}`);
    });
  });
}

async function cspViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
}

const drawer = (page: Page) => page.getByRole('dialog', { name: NAME });

test.beforeAll(async () => {
  const made = await createApplication(
    service(),
    TENANT_ID,
    {
      locale: 'en',
      name: NAME,
      email: EMAIL,
      phone: PHONE,
      city: 'Riyadh',
      role: 'Motion designer',
      experience: '3-6',
      workType: 'full-time',
      availability: 'month',
      skills: ['animation', 'branding'],
      portfolio: 'https://example.com/portfolio',
      message: 'I would love to join the studio.',
      consentApplication: true,
      consentFutureRoles: false,
      policyVersion: RECRUITMENT_POLICY_VERSION,
    },
    { file: PDF, kind: 'pdf' },
    KEY,
  );
  expect(made.ok, JSON.stringify(made)).toBe(true);
  if (made.ok) id = made.id;
  const other = await createApplication(
    service(),
    TENANT_ID,
    {
      locale: 'en',
      name: OTHER,
      email: `drawer-second-${RUN}@example.com`,
      phone: '+966500000124',
      city: 'Jeddah',
      role: 'Copywriter',
      experience: '3-6',
      workType: 'full-time',
      availability: 'month',
      skills: ['copywriting'],
      portfolio: 'https://example.com/second',
      message: OTHER_MESSAGE,
      consentApplication: true,
      consentFutureRoles: false,
      policyVersion: RECRUITMENT_POLICY_VERSION,
    },
    null,
    KEY,
  );
  expect(other.ok, JSON.stringify(other)).toBe(true);
  if (other.ok) otherId = other.id;
});

test.afterAll(async () => {
  const svc = service();
  for (const made of [id, otherId].filter(Boolean)) {
    const { data } = await svc
      .from('job_applications')
      .select('cv_path')
      .eq('id', made)
      .maybeSingle();
    const path = (data as { cv_path?: string | null } | null)?.cv_path;
    if (path) await svc.storage.from(CV_BUCKET).remove([path]);
    await svc.from('job_applications').delete().eq('id', made);
  }
});

for (const width of [320, 390, 1280]) {
  test(`the list at ${width}px: clean, no sideways scroll, no CSP violation`, async ({ page }) => {
    await watchCsp(page);
    await page.setViewportSize({ width, height: 900 });
    const res = await page.goto('/admin/applications');
    expect(res?.status()).toBe(200);
    await ready(page);
    await expect(page.getByRole('table', { name: 'Job applications' })).toBeVisible();
    await expect(page.getByRole('button', { name: `Open ${NAME}’s application` })).toBeAttached();
    await axeClean(page, `list ${width}`);
    await noSidewaysScroll(page, `list ${width}`);
    expect(await cspViolations(page)).toEqual([]);
  });
}

test('the status chips filter the list, and the address keeps the filter', async ({ page }) => {
  await page.goto('/admin/applications');
  await ready(page);
  const chips = page.getByRole('group', { name: 'Filter by status' });
  await chips.getByRole('button', { name: 'Hired' }).click();
  await expect(page.getByRole('button', { name: `Open ${NAME}’s application` })).toHaveCount(0);
  await expect(page).toHaveURL(/[?&]status=hired\b/);
  await chips.getByRole('button', { name: 'New' }).click();
  await expect(page.getByRole('button', { name: `Open ${NAME}’s application` })).toBeAttached();
});

test('?open= opens the application in the drawer, and the drawer is clean', async ({ page }) => {
  await watchCsp(page);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/admin/applications?open=${id}`);
    await ready(page);
    await expect(drawer(page)).toBeVisible();
    await expect(drawer(page).getByText('I would love to join the studio.')).toBeVisible();
    await expect(drawer(page).getByText(EMAIL)).toHaveCount(0);
    await axeClean(page, `drawer ${width}`);
    await noSidewaysScroll(page, `drawer ${width}`);
  }
  expect(await cspViolations(page)).toEqual([]);
});

test('a reveal is one audited read; a status or notes save after it reads nothing again', async ({
  page,
}) => {
  const before = await auditCount('application.view_pii');
  await page.goto(`/admin/applications?open=${id}`);
  await ready(page);
  const panel = drawer(page);
  await panel.getByRole('button', { name: 'Reveal contact details' }).click();
  await expect(panel.getByRole('link', { name: EMAIL })).toBeVisible();
  await expect(panel.getByRole('link', { name: PHONE })).toBeVisible();
  expect(await auditCount('application.view_pii')).toBe(before + 1);

  // Every request from here on, recorded: none may ask for the contact details.
  const asked: string[] = [];
  page.on('request', (request) => asked.push(request.url()));

  await panel.getByRole('combobox', { name: 'Status' }).selectOption('in_review');
  await expect(page.getByText('Status changed to In review.')).toBeVisible();
  await panel
    .getByRole('textbox', { name: 'Notes for the team' })
    .fill('Strong reel. Call back next week.');
  await panel.getByRole('button', { name: 'Save notes' }).click();
  await expect(page.getByText('Notes saved.')).toBeVisible();

  await expect(panel.getByRole('link', { name: EMAIL })).toBeVisible();
  expect(asked.filter((url) => url.includes('pii=1'))).toEqual([]);
  expect(await auditCount('application.view_pii')).toBe(before + 1);

  // "Hide" drops them; the stored status and notes are what the drawer said.
  await panel.getByRole('button', { name: 'Hide' }).click();
  await expect(panel.getByText(EMAIL)).toHaveCount(0);
  const { data } = await service()
    .from('job_applications')
    .select('status,internal_notes')
    .eq('id', id)
    .maybeSingle();
  expect(data).toEqual({
    status: 'in_review',
    internal_notes: 'Strong reel. Call back next week.',
  });
});

test('spam asks first, and Cancel changes nothing', async ({ page }) => {
  await page.goto(`/admin/applications?open=${id}`);
  await ready(page);
  const panel = drawer(page);
  await panel.getByRole('combobox', { name: 'Status' }).selectOption('spam');
  const ask = page.getByRole('dialog').filter({ hasText: 'Mark as spam?' });
  await expect(ask).toBeVisible();
  await expect(ask).toContainText('It will be deleted within 30 days.');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(panel.getByRole('combobox', { name: 'Status' })).toHaveValue('in_review');
  const { data } = await service().from('job_applications').select('status').eq('id', id).single();
  expect((data as { status: string }).status).toBe('in_review');
});

test('the CV link: an audited attachment, sandboxed and never cached', async ({ page }) => {
  await page.goto(`/admin/applications?open=${id}`);
  await ready(page);
  const link = drawer(page).getByRole('link', { name: 'Download CV' });
  await expect(link).toHaveAttribute('href', `/api/admin/applications/${id}/cv`);
  await expect(drawer(page).getByText('Not virus-scanned')).toBeVisible();
  const before = await auditCount('application.cv_download');
  const res = await page.request.get(`/api/admin/applications/${id}/cv`);
  expect(res.status()).toBe(200);
  const headers = res.headers();
  expect(headers['content-disposition']).toMatch(/^attachment/);
  expect(headers['content-security-policy']).toContain('sandbox');
  expect(headers['cache-control']).toContain('no-store');
  expect(await auditCount('application.cv_download')).toBe(before + 1);
});

test('a slow save for one application never lands in the drawer of the next', async ({ page }) => {
  await page.goto(`/admin/applications?open=${id}`);
  await ready(page);
  // The first application's PATCH is held until the second is on screen.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const path = `/api/admin/applications/${id}`;
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() === 'PATCH') await held;
    await route.continue();
  });
  await drawer(page).getByRole('combobox', { name: 'Status' }).selectOption('shortlisted');
  await drawer(page).getByRole('button', { name: 'Close' }).last().click();
  await expect(drawer(page)).toBeHidden();

  await page.getByRole('button', { name: `Open ${OTHER}’s application` }).click();
  const second = page.getByRole('dialog', { name: OTHER });
  await expect(second.getByText(OTHER_MESSAGE)).toBeVisible();
  const answered = page.waitForResponse(
    (r) => new URL(r.url()).pathname === path && r.request().method() === 'PATCH',
  );
  release();
  expect((await answered).status()).toBe(200);
  await expect(page.getByText('Status changed to Shortlisted.')).toBeVisible();
  await page.unroute(`**${path}`);

  // The second is still itself: its name, its message and its status, nothing of the first.
  await expect(second).toBeVisible();
  await expect(second.getByText(OTHER_MESSAGE)).toBeVisible();
  await expect(second.getByText('I would love to join the studio.')).toHaveCount(0);
  await expect(second.getByRole('combobox', { name: 'Status' })).toHaveValue('new');
  await expect(drawer(page)).toHaveCount(0);
  const svc = service();
  const { data: first } = await svc.from('job_applications').select('status').eq('id', id).single();
  expect((first as { status: string }).status).toBe('shortlisted');
  const { data: next } = await svc
    .from('job_applications')
    .select('status')
    .eq('id', otherId)
    .single();
  expect((next as { status: string }).status).toBe('new');
});

test('erase asks first, then the application and its CV are gone', async ({ page }) => {
  const svc = service();
  const { data: before } = await svc
    .from('job_applications')
    .select('cv_path')
    .eq('id', id)
    .single();
  const path = (before as { cv_path: string }).cv_path;
  expect(path).toMatch(new RegExp(`^${TENANT_ID}/${id}/[^/]+\\.pdf$`));

  await page.goto(`/admin/applications?open=${id}`);
  await ready(page);
  await drawer(page).getByRole('button', { name: 'Erase application' }).click();
  const ask = page.getByRole('dialog').filter({ hasText: 'This cannot be undone.' });
  await expect(ask).toContainText(NAME);
  await ask.getByRole('button', { name: 'Erase' }).click();
  await expect(page.getByText('Application erased.')).toBeVisible();
  await expect(drawer(page)).toBeHidden();
  await expect(page).not.toHaveURL(/[?&]open=/);

  const { data: row } = await svc.from('job_applications').select('id').eq('id', id).maybeSingle();
  expect(row).toBeNull();
  const folder = path.split('/').slice(0, 2).join('/');
  const { data: objects } = await svc.storage.from(CV_BUCKET).list(folder);
  expect(objects ?? []).toEqual([]);
  id = '';

  // The drawer stays mounted: the next application opens ready, nothing left disabled.
  await page.getByRole('button', { name: `Open ${OTHER}’s application` }).click();
  const next = page.getByRole('dialog', { name: OTHER });
  await expect(next.getByText(OTHER_MESSAGE)).toBeVisible();
  await expect(next.getByRole('button', { name: 'Reveal contact details' })).toBeEnabled();
  await expect(next.getByRole('combobox', { name: 'Status' })).toBeEnabled();
  await expect(next.getByRole('button', { name: 'Erase application' })).toBeEnabled();
});
