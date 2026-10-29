import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { TENANT_ID } from '../../scripts/gen-seeds.mjs';
import { SKIP_REASON, authFile, releasesOn, staffEnv } from './staff';

/*
 * The release drill in CI (Admin v2 R14-prep; plan B5: "rehearsed first in CI ... then a
 * publish and a rollback drill"). Runs ONLY in the release-mode rehearsal (E2E_RELEASES=on,
 * .github/workflows/releases-rehearsal.yml): tests/admin/releases.setup.ts has switched releases
 * on for the e2e tenant with `app.enable_releases`, as the launch runbook's §6p does in
 * production. Its own project (playwright.config.ts `releases-mode`), after every public and
 * admin spec and before the ones that change the whole site, because Publish puts every
 * selected pending change live: nothing else may be pending or publishing meanwhile.
 *
 * As the Admin, on a question of this run's own (a random marker, the FAQ on /contact):
 *
 *   publish    a new question saved through the FAQ route waits as a pending change (not on
 *              /contact); the savebar counts it; Publish… in the dialog puts it live as a new
 *              version ("Published vP"), and /contact shows it;
 *   history    its History (R13's drawer route) lists the version and offers Restore now; so does
 *              the site identity's, asked with no id (R14-prep);
 *   scheduled  a new wording, scheduled through the publish route about two and a half minutes
 *              ahead, is listed on Backups & versions as Scheduled; once due, the minute cron
 *              (wrangler dev --test-scheduled: GET /__scheduled) fires it as a version of its
 *              own, and /contact shows the new wording;
 *   rollback   on Backups & versions, Restore vP stages the question as it was, "Publish vP
 *              again" (its confirm) publishes it as a rollback naming vP, and /contact shows the
 *              first wording again;
 *   dashboard  the publish card is on the board and names the live version.
 *
 * The edit and the schedule go through the routes the editor and the dialog call (with the
 * session's CSRF token, as the samples do), so their timing is exact; the dialog's own schedule
 * controls are driven on the kit (tests/admin/releases-ui.e2e.ts). The question is removed by
 * the service role at the end, whatever failed; pending changes other specs left behind are
 * removed first (this suite publishes everything it selects).
 */

test.skip(!releasesOn(), 'releases are off: the rehearsal sets E2E_RELEASES=on');
test.skip(!staffEnv(), SKIP_REASON);
test.use({ storageState: authFile('admin'), contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ mode: 'serial' });

const MARK = `E2E R ${randomBytes(4).toString('hex')}`;
const Q1 = { en: `${MARK}: first wording?`, ar: `${MARK}: الصياغة الأولى؟` };
const Q2 = { en: `${MARK}: second wording?`, ar: `${MARK}: الصياغة الثانية؟` };
const ANSWER = { en: 'Yes. Answer first, one paragraph.', ar: 'نعم. الإجابة أولًا، فقرة واحدة.' };

function service() {
  const env = staffEnv()!;
  return createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

let faqId = '';
let published = 0;
let scheduledNumber = 0;

test.beforeAll(async () => {
  // This suite publishes every change it selects: a change another spec left pending would go
  // live with it. Unclaimed pending changes only (the draft table is the service role's).
  const { error } = await service()
    .from('content_drafts')
    .delete()
    .eq('tenant_id', TENANT_ID)
    .is('release_id', null);
  expect(error).toBeNull();
});

test.afterAll(async () => {
  if (!staffEnv()) return;
  const svc = service();
  if (faqId) await svc.from('content_drafts').delete().eq('entity_id', faqId);
  await svc.from('faq_items').delete().like('question->>en', `${MARK}%`);
});

/** The double-submit token the admin's own fetches send (the `__Host-csrf` cookie). */
async function csrf(page: Page): Promise<Record<string, string>> {
  await page.goto('/admin', { waitUntil: 'domcontentloaded' });
  const token = (await page.context().cookies()).find((c) => c.name === '__Host-csrf')?.value;
  expect(token, 'the admin session carries a CSRF cookie').toBeTruthy();
  return { 'x-csrf-token': token! };
}

async function open(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
}

/** The questions /contact shows. */
async function contactQuestions(page: Page): Promise<string[]> {
  await page.goto('/contact', { waitUntil: 'load' });
  return page.$$eval('.faq-item__t', (els) => els.map((e) => (e.textContent ?? '').trim()));
}

const data = async <T>(res: { json: () => Promise<unknown> }): Promise<T> => {
  const body = (await res.json()) as { data?: T } & T;
  return (body.data ?? body) as T;
};

interface Pending {
  items: { draftId: string; draftVersion: number; entityId: string; scheduled: boolean }[];
}
interface Versions {
  live: number | null;
  versions: { id: string; number: number | null; kind: string; restores: number | null }[];
  upcoming: { id: string; status: string }[];
}

test('publish: a new question waits as a pending change, then goes live as a version', async ({
  page,
}) => {
  const headers = await csrf(page);
  // A create in release mode says so (R12b: the editors' `?staged=1`).
  const created = await page.request.post('/api/admin/faq?staged=1', {
    headers,
    data: { question: Q1, answer: ANSWER, status: 'published', sortOrder: 9_999 },
  });
  expect(created.status(), await created.text()).toBe(200);
  const row = await data<{ id: string; draft?: unknown }>(created);
  expect(row.draft, 'the save is a pending change, not a live write').toBeTruthy();
  faqId = row.id;
  expect(await contactQuestions(page)).not.toContain(Q1.en);

  await open(page, '/admin/faq');
  // The savebar mounts when the browser is idle and then reads the pending changes.
  const bar = page.getByRole('region', { name: 'Unpublished changes' });
  await expect(bar).toBeVisible({ timeout: 15_000 });
  await bar.getByRole('button', { name: 'Publish…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Publish to the website' });
  await expect(dialog).toBeVisible();
  const go = dialog.getByRole('button', { name: /^Publish 1 change$/ });
  await expect(go).toBeEnabled();
  await go.click();
  const toast = page.locator('#admin-toasts .toast', {
    hasText: /Published v\d+\. The website now shows these changes\./,
  });
  await expect(toast).toBeVisible();
  published = Number((/v(\d+)/.exec((await toast.textContent()) ?? '') ?? [])[1]);
  expect(published).toBeGreaterThanOrEqual(2);
  await expect(dialog).toBeHidden();

  expect(await contactQuestions(page)).toContain(Q1.en);
});

test('history: the question and the site identity list their versions and offer Restore', async ({
  page,
}) => {
  await open(page, '/admin');
  const faq = await page.request.get(`/api/admin/history?entityType=faq_item&entityId=${faqId}`);
  expect(faq.status(), await faq.text()).toBe(200);
  const answer = await data<{
    enabled: boolean;
    restorable: boolean;
    versions: { release: { number: number | null } | null; live: boolean }[];
  }>(faq);
  expect(answer).toMatchObject({ enabled: true, restorable: true });
  expect(answer.versions[0]).toMatchObject({ live: true, release: { number: published } });

  // The identity's history names the site, not an id (R14-prep).
  const identity = await page.request.get('/api/admin/history?entityType=site_profile');
  expect(identity.status(), await identity.text()).toBe(200);
  expect(await data<{ enabled: boolean; restorable: boolean }>(identity)).toMatchObject({
    enabled: true,
    restorable: true,
  });
});

test('scheduled: a new wording goes live from the minute cron once due', async ({ page }) => {
  // About two and a half minutes ahead (the route's minimum is 2), then the cron's own wait.
  test.setTimeout(8 * 60_000);
  const headers = await csrf(page);
  const live = await page.request.get(`/api/admin/faq/${faqId}`);
  expect(live.status(), await live.text()).toBe(200);
  const version = (await data<{ version: number }>(live)).version;
  const edited = await page.request.patch(`/api/admin/faq/${faqId}`, {
    headers,
    data: { question: Q2, version, staged: true },
  });
  expect(edited.status(), await edited.text()).toBe(200);
  expect(await contactQuestions(page)).toContain(Q1.en);

  const pending = await data<Pending>(await page.request.get('/api/admin/releases/pending'));
  const mine = pending.items.filter((item) => item.entityId === faqId && !item.scheduled);
  expect(mine).toHaveLength(1);
  const due = Date.now() + 150_000;
  const scheduled = await page.request.post('/api/admin/releases', {
    headers,
    data: {
      items: mine.map(({ draftId, draftVersion }) => ({ draftId, draftVersion })),
      scheduleAt: new Date(due).toISOString(),
    },
  });
  expect(scheduled.status(), await scheduled.text()).toBe(200);
  const releaseId = (await data<{ release: { id: string } }>(scheduled)).release.id;

  // Backups & versions lists it as scheduled, with its moves.
  await open(page, '/admin/backups');
  const upcoming = page.getByRole('list', { name: 'Scheduled and failed releases' });
  await expect(upcoming.getByText('Scheduled', { exact: true })).toBeVisible();
  await expect(upcoming.getByRole('button', { name: 'Unschedule' })).toBeVisible();

  // Due: the minute cron fires it (wrangler dev --test-scheduled runs the Worker's `scheduled`
  // for GET /__scheduled; the job runs after the answer, so the version is polled for).
  await page.waitForTimeout(Math.max(0, due - Date.now()) + 2_000);
  await expect
    .poll(
      async () => {
        await page.request.get('/__scheduled?cron=*+*+*+*+*');
        await page.waitForTimeout(3_000);
        const list = await data<Versions>(await page.request.get('/api/admin/releases'));
        return list.versions.find((v) => v.id === releaseId)?.number ?? null;
      },
      { timeout: 120_000, intervals: [1_000] },
    )
    .not.toBeNull();
  const list = await data<Versions>(await page.request.get('/api/admin/releases'));
  scheduledNumber = list.versions.find((v) => v.id === releaseId)!.number!;
  expect(scheduledNumber).toBeGreaterThan(published);
  expect(list.live).toBe(scheduledNumber);

  const questions = await contactQuestions(page);
  expect(questions).toContain(Q2.en);
  expect(questions).not.toContain(Q1.en);
});

test('rollback: Restore vP, then Publish vP again, brings the first wording back', async ({
  page,
}) => {
  await open(page, '/admin/backups');
  const list = page.getByRole('list', { name: 'Published versions' });
  await expect(list).toBeVisible();
  await list.getByRole('button', { name: `Restore v${published}`, exact: true }).click();
  const confirm = page.getByRole('dialog').filter({ hasText: `Restore v${published}?` });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(
    page.locator('#admin-toasts .toast', {
      hasText: `v${published} restored. Publish to make it live.`,
    }),
  ).toBeVisible();
  // Nothing is live until it is published.
  expect(await contactQuestions(page)).toContain(Q2.en);

  await open(page, '/admin/backups');
  const again = list.getByRole('button', { name: `Publish v${published} again`, exact: true });
  await expect(again).toBeVisible();
  await again.click();
  const sure = page.getByRole('dialog').filter({ hasText: `Publish v${published} again?` });
  await expect(sure).toBeVisible();
  await sure.getByRole('button', { name: `Publish v${published} again`, exact: true }).click();
  // The page reads the list again; the island says so once it has loaded.
  await expect(
    page.locator('#admin-toasts .toast', {
      hasText: 'Published. The website now shows the restored version.',
    }),
  ).toBeVisible({ timeout: 15_000 });

  const versions = await data<Versions>(await page.request.get('/api/admin/releases'));
  const newest = versions.versions[0]!;
  expect(newest).toMatchObject({ kind: 'rollback', restores: published });
  expect(newest.number).toBeGreaterThan(scheduledNumber);
  await expect(list.getByText(`Restored v${published}`).first()).toBeVisible();

  const questions = await contactQuestions(page);
  expect(questions).toContain(Q1.en);
  expect(questions).not.toContain(Q2.en);
});

test('dashboard: the publish card names the live version', async ({ page }) => {
  await open(page, '/admin');
  const card = page.locator('[data-widget="publish"]');
  await expect(card).toBeVisible();
  const live = (await data<Versions>(await page.request.get('/api/admin/releases'))).live;
  await expect(card.locator('.stat-row dd').first()).toContainText(`v${live}`);
});
