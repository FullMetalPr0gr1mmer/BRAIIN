import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { MOVE_ARCHIVED } from '@/components/admin/screens/resources/reorder';
import { TENANT_ID } from '../../scripts/gen-seeds.mjs';
import { RELEASES_OFF_ONLY, SKIP_REASON, authFile, releasesOn, staffEnv } from './staff';

/*
 * Move up and Move down past an archived row (Admin v2 hotfix H12), signed in as
 * content_creator, through the real Worker and this job's local Supabase. The archive gates
 * (portfolio: 0007's RESTRICTIVE `portfolio_archive_admin`) let only an Admin write a row that
 * stays archived, so before H12 a Content Creator's move next to an archived row always failed,
 * and the route's one-at-a-time updates could leave half of a move behind.
 *
 * Since Admin v2 U5 + U6 the screen is the Projects list (/admin/portfolio, AdminProjects),
 * which moves rows exactly as ResourceTable does (screens/resources/reorder.ts): /admin/services
 * became the disciplines' overview, and the services are ordered on a discipline's page.
 *
 *   the screen   on /admin/portfolio, three projects of this run's own (a live one, an archived
 *                one, a live one): the archived row's buttons are disabled, and the first row's
 *                Move down swaps it with the third, stepping over the archived one. The
 *                request names the two live rows only, the route answers 200, no error is
 *                shown, the list re-reads in its new order, and the database holds the two
 *                swapped numbers with the archived row untouched (its number and version);
 *   the server   the same person's request naming the archived row, sent by hand with a
 *                valid CSRF token and origin, is refused whole (403, content.archiveDelete)
 *                and moves nothing, the live row it also named included;
 *   stale list   the row a move would swap with is archived (by the service role) after the
 *                list loaded: the move is refused (403), nothing is written, the list is re-read
 *                (its buttons now step over that row) and the screen says why (MOVE_ARCHIVED).
 *
 * The rows are made by the service role with a random marker in the slug and removed by it
 * afterwards. They stay drafts or archived, so no public page shows them, and their numbers
 * sort after every seeded service, so the sweep's "first row" edit screen is never one of them.
 */

test.skip(!staffEnv(), SKIP_REASON);
// The release-mode rehearsal (Admin v2 R14-prep): written for releases off.
test.skip(releasesOn(), RELEASES_OFF_ONLY);
test.use({
  contextOptions: { reducedMotion: 'reduce' },
  storageState: authFile('content_creator'),
});
test.describe.configure({ mode: 'serial' });

const MARK = randomBytes(4).toString('hex');
const slug = (kind: string) => `e2e-h12-${kind}-${MARK}`;
const title = (kind: string) => ({ en: `Order ${kind} ${MARK}`, ar: `ترتيب ${kind} ${MARK}` });

const ROWS = {
  first: { slug: slug('first'), title: title('first'), status: 'draft', sort_order: 99910 },
  shelved: {
    slug: slug('shelved'),
    title: title('shelved'),
    status: 'archived',
    sort_order: 99920,
  },
  second: { slug: slug('second'), title: title('second'), status: 'draft', sort_order: 99930 },
} as const;
type Kind = keyof typeof ROWS;

const ids: Partial<Record<Kind, string>> = {};

function service() {
  const env = staffEnv()!;
  return createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

test.beforeAll(async () => {
  if (!staffEnv()) return;
  const { data, error } = await service()
    .from('portfolio')
    .insert(Object.values(ROWS).map((row) => ({ tenant_id: TENANT_ID, ...row })))
    .select('id,slug');
  expect(error).toBeNull();
  for (const kind of Object.keys(ROWS) as Kind[]) {
    ids[kind] = (data ?? []).find((row) => row.slug === ROWS[kind].slug)?.id as string;
    expect(ids[kind], kind).toBeTruthy();
  }
});

test.afterAll(async () => {
  if (!staffEnv()) return;
  await service().from('portfolio').delete().like('slug', `e2e-h12-%-${MARK}`);
});

/** The three rows as stored: number, status and version, by kind. */
async function stored(): Promise<
  Record<Kind, { sort_order: number; status: string; version: number }>
> {
  const { data, error } = await service()
    .from('portfolio')
    .select('slug,sort_order,status,version')
    .like('slug', `e2e-h12-%-${MARK}`);
  expect(error).toBeNull();
  const of = (kind: Kind) => {
    const row = (data ?? []).find((r) => r.slug === ROWS[kind].slug);
    expect(row, kind).toBeTruthy();
    return { sort_order: row!.sort_order, status: row!.status, version: row!.version };
  };
  return { first: of('first'), shelved: of('shelved'), second: of('second') };
}

/** The projects list, searched down to this run's three rows. */
async function openList(page: Page) {
  await page.goto('/admin/portfolio', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  await page.getByLabel('Search projects', { exact: true }).fill(MARK);
  await expect(page.locator('table.data a.data-link')).toHaveText([
    ROWS.first.title.en,
    ROWS.shelved.title.en,
    ROWS.second.title.en,
  ]);
}

const moveButton = (page: Page, kind: Kind, way: 'up' | 'down') =>
  page.getByRole('button', { name: `Move ${ROWS[kind].title.en} ${way}`, exact: true });

test('a Content Creator moves a project past an archived one; the archived row is not written', async ({
  page,
}) => {
  await openList(page);
  const before = await stored();

  // The archived row does not move; the ends of the list have nowhere to go.
  await expect(moveButton(page, 'shelved', 'up')).toBeDisabled();
  await expect(moveButton(page, 'shelved', 'down')).toBeDisabled();
  await expect(moveButton(page, 'first', 'up')).toBeDisabled();
  await expect(moveButton(page, 'second', 'down')).toBeDisabled();
  await expect(moveButton(page, 'first', 'down')).toBeEnabled();
  await expect(moveButton(page, 'second', 'up')).toBeEnabled();

  const answered = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/admin/portfolio/reorder' &&
      r.request().method() === 'POST',
  );
  // Row actions are drawn on hover or focus: focus it and press Enter.
  const down = moveButton(page, 'first', 'down');
  await down.focus();
  await down.press('Enter');
  const response = await answered;

  // The request names the two live rows only, and swaps their numbers.
  expect(response.request().postDataJSON()).toEqual({
    items: [
      { id: ids.first, sortOrder: ROWS.second.sort_order },
      { id: ids.second, sortOrder: ROWS.first.sort_order },
    ],
  });
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ ok: true, data: { reordered: 2 } });

  // The list re-reads in its new order, with no error on the screen.
  await expect(page.locator('table.data a.data-link')).toHaveText([
    ROWS.second.title.en,
    ROWS.shelved.title.en,
    ROWS.first.title.en,
  ]);
  await expect(page.locator('main .msg[data-kind="error"]')).toHaveCount(0);
  await expect(moveButton(page, 'second', 'up')).toBeDisabled();
  await expect(moveButton(page, 'first', 'down')).toBeDisabled();

  const after = await stored();
  expect(after.first.sort_order).toBe(ROWS.second.sort_order);
  expect(after.second.sort_order).toBe(ROWS.first.sort_order);
  expect(after.shelved).toEqual(before.shelved);
  expect(after.shelved).toMatchObject({ sort_order: ROWS.shelved.sort_order, status: 'archived' });
});

test('the server refuses a Content Creator move that names the archived row, writing nothing', async ({
  page,
}) => {
  await page.goto('/admin/portfolio', { waitUntil: 'networkidle' });
  const token = await page.locator('meta[name="csrf-token"]').getAttribute('content');
  expect(token, 'the admin layout carries a CSRF token').toBeTruthy();
  const before = await stored();

  // A live row first: before H12 the route moved it, then the archive gate refused the next.
  const res = await page.request.post('/api/admin/portfolio/reorder', {
    headers: { 'x-csrf-token': token!, origin: new URL(page.url()).origin },
    data: {
      items: [
        { id: ids.second, sortOrder: before.shelved.sort_order },
        { id: ids.shelved, sortOrder: before.second.sort_order },
      ],
    },
  });
  expect(res.status()).toBe(403);
  expect(await res.json()).toEqual({
    ok: false,
    error: 'forbidden',
    capability: 'content.archiveDelete',
  });
  expect(await stored()).toEqual(before);
});

test('a move past a row archived since the list loaded: refused, the list re-read, the reason shown', async ({
  page,
}) => {
  // After the first test the list reads second, shelved, first.
  await page.goto('/admin/portfolio', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  await page.getByLabel('Search projects', { exact: true }).fill(MARK);
  await expect(page.locator('table.data a.data-link')).toHaveText([
    ROWS.second.title.en,
    ROWS.shelved.title.en,
    ROWS.first.title.en,
  ]);
  await expect(moveButton(page, 'second', 'down')).toBeEnabled();

  // Someone else archives the row this move would swap with; the screen does not know.
  const { error } = await service()
    .from('portfolio')
    .update({ status: 'archived' })
    .eq('id', ids.first!);
  expect(error).toBeNull();
  const before = await stored();

  const answered = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/admin/portfolio/reorder' &&
      r.request().method() === 'POST',
  );
  const down = moveButton(page, 'second', 'down');
  await down.focus();
  await down.press('Enter');
  const response = await answered;
  expect(response.status()).toBe(403);
  expect(await response.json()).toEqual({
    ok: false,
    error: 'forbidden',
    capability: 'content.archiveDelete',
  });

  // The list is re-read: the row now shows as archived, so nothing below the first one is
  // left to swap with; and the screen says why the move did not happen.
  await expect(page.locator('main .msg[data-kind="error"]')).toHaveText(MOVE_ARCHIVED);
  await expect(moveButton(page, 'second', 'down')).toBeDisabled();
  await expect(moveButton(page, 'first', 'up')).toBeDisabled();
  // Nothing was written: the pre-check refused the whole move.
  expect(await stored()).toEqual(before);
});
