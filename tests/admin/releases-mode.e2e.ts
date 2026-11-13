import { randomBytes } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { TENANT_ID } from '../../scripts/gen-seeds.mjs';
import { STAFF_IDS, SKIP_REASON, authFile, releasesOn, staffEnv } from './staff';

/*
 * The release drill in CI (Admin v2 R14-prep; plan B5: "rehearsed first in CI ... then a
 * publish and a rollback drill"). Runs ONLY in release mode (E2E_RELEASES=on: since R14c the
 * required e2e job, perf-seo-a11y.yml `e2e`): tests/admin/releases.setup.ts has switched releases
 * on for the e2e tenant with `app.enable_releases`, as the launch runbook's §6p does in
 * production. Its own project (playwright.config.ts `releases-mode`), after every public and
 * admin spec and before the ones that change the whole site, because Publish puts every
 * selected pending change live: nothing else may be pending or publishing meanwhile.
 *
 * As the Admin, on a question of this run's own (a random marker, the FAQ on /contact):
 *
 *   room       with a pending change of its own (thrown away after), the shown savebar covers
 *              no control (R14a, WCAG 2.2 2.4.11): /admin/ai-config's last Save, focused while
 *              it sits in the bar's band and scrolled to the page's end, and the kit's stuck
 *              bulk bar, at phone, tablet and desktop widths, are each the element at their own
 *              centre and end above the bar (the first rehearsal's style-finder failure); every
 *              row control of the kit's table reached by Tab with the bulk bar stuck ends above
 *              the bulk bar;
 *   publish    a new question saved through the FAQ route waits as a pending change (not on
 *              /contact); the savebar counts it; Publish… in the dialog puts it live as a new
 *              version ("Published vP"), and /contact shows it;
 *   history    its History (R13's drawer route) lists the version and offers Restore now; so does
 *              the site identity's, asked with no id (R14-prep);
 *   scheduled  a new wording, scheduled through the publish route about two and a half minutes
 *              ahead, is listed on Backups & versions as Scheduled; once due, the minute cron
 *              (miniflare's own trigger, GET /cdn-cgi/local/scheduled) fires it as a version of
 *              its own, and /contact shows the new wording;
 *   rollback   on Backups & versions, Restore vP stages the question as it was, "Publish vP
 *              again" (its confirm) publishes it as a rollback naming vP, and /contact shows the
 *              first wording again;
 *   dashboard  the publish card is on the board and names the live version.
 *
 * The edit and the schedule go through the routes the editor and the dialog call (with the
 * session's CSRF token, as the samples do), so their timing is exact; the dialog's own schedule
 * controls are driven on the kit (tests/admin/releases-ui.e2e.ts). The question is removed by
 * the service role at the end, whatever failed; pending changes other specs left behind are
 * removed first (this suite publishes everything it selects), and named in an annotation so a
 * leak points at its spec. Every release still scheduled on the e2e tenant is unscheduled before
 * the drill and after it (R14a): a release a failed attempt left would otherwise be a second
 * "Scheduled" card on the retry, and would fire with the drill's own.
 */

test.skip(!releasesOn(), 'releases are off: the release-mode e2e job sets E2E_RELEASES=on');
test.skip(!staffEnv(), SKIP_REASON);
test.use({ storageState: authFile('admin'), contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ mode: 'serial' });

const MARK = `E2E R ${randomBytes(4).toString('hex')}`;
const Q1 = { en: `${MARK}: first wording?`, ar: `${MARK}: الصياغة الأولى؟` };
const Q2 = { en: `${MARK}: second wording?`, ar: `${MARK}: الصياغة الثانية؟` };
const ROOM_Q = { en: `${MARK}: room check?`, ar: `${MARK}: فحص المساحة؟` };
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

/**
 * Unschedules every release still scheduled on the e2e tenant, through the database's own path
 * (`public.unschedule_release` as the e2e Admin: its drafts released back to pending, the
 * release cancelled, an audit row), so the drill starts and ends with none.
 */
async function unscheduleAll() {
  const svc = service();
  const { data, error } = await svc
    .from('content_releases')
    .select('id,version')
    .eq('tenant_id', TENANT_ID)
    .eq('status', 'scheduled');
  expect(error).toBeNull();
  for (const release of (data ?? []) as { id: string; version: number }[]) {
    const cancelled = await svc.rpc('unschedule_release', {
      p_actor: STAFF_IDS.admin,
      p_role: 'admin',
      p_release: release.id,
      p_version: release.version,
    });
    expect(cancelled.error, `unschedule ${release.id}`).toBeNull();
  }
}

test.beforeAll(async () => {
  await unscheduleAll();
  // This suite publishes every change it selects: a change another spec left pending would go
  // live with it. Unclaimed pending changes only (the draft table is the service role's). What
  // is found is named first, so a spec that leaks one can be found from the report.
  const svc = service();
  const left = await svc
    .from('content_drafts')
    .select('entity_type,entity_id,created_by')
    .eq('tenant_id', TENANT_ID)
    .is('release_id', null);
  expect(left.error).toBeNull();
  const rows = (left.data ?? []) as {
    entity_type: string;
    entity_id: string;
    created_by: string | null;
  }[];
  if (rows.length > 0) {
    const named = rows.map((r) => `${r.entity_type} ${r.entity_id} by ${r.created_by ?? '?'}`);
    // In the report (an annotation) and in the job's log (the line reporter prints stderr).
    test.info().annotations.push({
      type: 'pending changes other specs left',
      description: named.join('; '),
    });
    console.warn(`releases-mode: removing pending changes other specs left: ${named.join('; ')}`);
  }
  const { error } = await svc
    .from('content_drafts')
    .delete()
    .eq('tenant_id', TENANT_ID)
    .is('release_id', null);
  expect(error).toBeNull();
});

test.afterAll(async () => {
  if (!staffEnv()) return;
  // A drill that stopped between its schedule and the fire leaves a scheduled release.
  await unscheduleAll();
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

/**
 * The control is clear of the shown savebar: it ends above the bar's top, and the element at its
 * centre is the control (or inside it), so a press lands on it.
 */
async function expectClear(page: Page, control: Locator, bar: Locator, label: string) {
  const box = await control.boundingBox();
  const barBox = await bar.boundingBox();
  expect(box, `${label}: on screen`).not.toBeNull();
  expect(barBox, `${label}: the savebar is on screen`).not.toBeNull();
  expect(box!.y + box!.height, `${label}: ends above the savebar`).toBeLessThanOrEqual(barBox!.y);
  const own = await control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return at !== null && (at === el || el.contains(at));
  });
  expect(own, `${label}: the element at its centre is its own`).toBe(true);
}

/**
 * Scrolls the page so the control's centre is at the shown savebar's centre, and says whether
 * the control is then under the bar (the precondition of a focus check that depends on the
 * scroll padding).
 */
async function placeInBand(control: Locator): Promise<boolean> {
  return control.evaluate((el) => {
    const bar = document.querySelector('.savebar[data-shown]:not([data-inline])');
    if (!bar) return false;
    const b = bar.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    window.scrollBy(0, r.top + r.height / 2 - (b.top + b.height / 2));
    const now = el.getBoundingClientRect();
    return now.bottom > b.top && now.top < b.bottom;
  });
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

test('room: the shown savebar covers no screen’s last control, focus or the bulk bar', async ({
  page,
}) => {
  test.slow();
  const headers = await csrf(page);
  const created = await page.request.post('/api/admin/faq?staged=1', {
    headers,
    data: { question: ROOM_Q, answer: ANSWER, status: 'published', sortOrder: 9_998 },
  });
  expect(created.status(), await created.text()).toBe(200);
  const row = await data<{ id: string; draft?: unknown }>(created);
  expect(row.draft, 'the save is a pending change, not a live write').toBeTruthy();
  try {
    // The fixed bar (the kit's gallery also draws one in its page: data-inline).
    const bar = page.locator('.savebar[data-shown]:not([data-inline])');
    for (const width of [1280, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 720 });
      // An immediate screen whose last control is its form's Save (EditorForm's actions row).
      await open(page, '/admin/ai-config');
      await expect(bar).toBeVisible({ timeout: 15_000 });
      const save = page.getByRole('button', { name: /^Save style-finder results/ });
      await expect(save).toBeVisible();
      // Focused while it sits in the bar's band: the browser scrolls a control it focuses only
      // when it lies outside the scroll port less the scroll padding, so the Save ends clear of
      // the bar only while that padding keeps the bar's room (C43). Focused from the top
      // instead, Chromium centres an off-screen control and the padding is never tested (R14a
      // review). The page is first scrolled so the Save's centre is at the bar's, and that it
      // is under the bar is asserted, so the check cannot pass on a page that never put it there.
      expect(
        await placeInBand(save),
        `ai-config Save sits under the bar before it is focused, ${width}px`,
      ).toBe(true);
      await save.focus();
      await expect(save).toBeFocused();
      await expectClear(page, save, bar, `ai-config Save, focused in the bar's band, ${width}px`);
      // The page scrolled to its end, where the first rehearsal found it under the bar.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expectClear(page, save, bar, `ai-config Save, at the end, ${width}px`);
    }
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 720 });
      await open(page, '/admin/kit');
      await expect(bar).toBeVisible({ timeout: 15_000 });
      const card = page.getByRole('region', { name: 'A data table' });
      const table = card.getByRole('table', { name: 'Sample entries, with selection' });
      await table.getByRole('checkbox', { name: 'Select all on this page' }).check();
      const bulk = page.getByRole('region', { name: 'Bulk actions' });
      await expect(bulk).toContainText('25 selected');
      // The table's first rows at the top and the rest past the window: the bulk bar is stuck
      // to the bottom of the window, where the savebar is.
      await table.evaluate((el) => el.scrollIntoView({ block: 'start' }));
      expect(
        await table.evaluate((el) => el.getBoundingClientRect().bottom > window.innerHeight),
        `the table runs past the window at ${width}px, so the bulk bar is stuck`,
      ).toBe(true);
      // Every row's controls reached by Tab with the bulk bar stuck over the band above the
      // savebar: each is the element at its own centre and ends above the bulk bar, so focus
      // is never left behind it (R14a review, WCAG 2.2 2.4.11: the scroll padding keeps both
      // bars' room while a bulk bar shows). The walk must reach all 25 rows (a checkbox, the
      // title link and Preview each) and must scroll the page, so it cannot pass empty.
      await table
        .getByRole('checkbox', { name: 'Select all on this page' })
        .evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));
      const startY = await page.evaluate(() => window.scrollY);
      let walked = 0;
      for (let i = 0; i < 120; i += 1) {
        await page.keyboard.press('Tab');
        const at = await table.evaluate((t) => {
          const el = document.activeElement as HTMLElement | null;
          const body = (t as HTMLTableElement).tBodies[0];
          if (!el || !body?.contains(el)) return null;
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          const bulkTop = document.querySelector('.bulkbar')?.getBoundingClientRect().top ?? 0;
          return {
            name: el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.tagName,
            own: hit !== null && (hit === el || el.contains(hit)),
            bottom: r.bottom,
            bulkTop,
          };
        });
        if (at === null) break;
        walked += 1;
        expect(at.own, `${at.name}, reached by Tab at ${width}px: the element at its centre`).toBe(
          true,
        );
        expect(
          at.bottom,
          `${at.name}, reached by Tab at ${width}px: ends above the bulk bar`,
        ).toBeLessThanOrEqual(at.bulkTop + 1);
      }
      expect(walked, `Tab reached every row's controls at ${width}px`).toBeGreaterThanOrEqual(75);
      expect(
        await page.evaluate(() => window.scrollY),
        `the walk scrolled the page at ${width}px`,
      ).toBeGreaterThan(startY);
      await table.evaluate((el) => el.scrollIntoView({ block: 'start' }));
      const clear = bulk.getByRole('button', { name: 'Clear selection' });
      await expectClear(page, clear, bar, `bulk bar Clear selection, ${width}px`);
      await clear.click();
      await expect(bulk).toHaveCount(0);
    }
  } finally {
    // Its own pending change only: a create, so nothing of it is live.
    const { error } = await service()
      .from('content_drafts')
      .delete()
      .eq('tenant_id', TENANT_ID)
      .eq('entity_id', row.id);
    expect(error).toBeNull();
  }
});

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

  // Due: the minute cron fires it. Miniflare's own trigger runs the Worker's `scheduled` for
  // GET /cdn-cgi/local/scheduled and answers its outcome ("ok"); wrangler's `/__scheduled` is a
  // bundling middleware that a no_bundle build (the Astro adapter's) never gets, so it would
  // reach the site and 404 (R14a). The job runs in waitUntil, so the version is polled for.
  await page.waitForTimeout(Math.max(0, due - Date.now()) + 2_000);
  await expect
    .poll(
      async () => {
        const fired = await page.request.get('/cdn-cgi/local/scheduled?cron=*+*+*+*+*');
        expect(fired.status(), await fired.text()).toBe(200);
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
