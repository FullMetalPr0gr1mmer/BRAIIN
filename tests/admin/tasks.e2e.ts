import AxeBuilder from '@axe-core/playwright';
import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { SKIP_REASON, STAFF_IDS, authFile, staffEnv } from './staff';

/*
 * Tasks, end to end (Admin v2 C8, crm.md §11 screen 10 and §13), on the real Worker and the
 * local stack:
 *   the screen  as the Admin: a task added through the drawer (10:00 by default) lands in its
 *               list; an overdue one of mine lights the sidebar's Tasks count; ticking moves a
 *               task to Done; the snooze sets tomorrow 10:00 in the studio's zone; a stale
 *               version is a 409, and in the drawer a 409 shows the task as it is now so the
 *               next Save goes through (C8 review, C8-UX-1); the calendar file is an
 *               attachment carrying the title, a link to Everyone's list and no note; axe with
 *               the drawer open;
 *   a lead      the Tasks card on a lead's page adds a task about that lead;
 *   a contact   (C8b) the same card on a contact's page adds a task about that contact, and
 *               the contact's timeline says so;
 *   Sales       (Admin v2 C10b: crm.tasks) Tasks in its menu; a task of its own lands in My
 *               tasks and is ticked off on the screen; a task for a Developer is refused
 *               (the owner rule: a crm.tasks holder);
 *   refusals    Content Creator, SEO and Developer get a 403 page (and API), and no Tasks
 *               link (crm.tasks is Admin's and Sales').
 * Every task is named with this run's token and added through the real routes; nothing reads
 * or writes the database directly.
 */

test.skip(!staffEnv(), SKIP_REASON);
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const RUN = randomBytes(4).toString('hex');

async function axe(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(
    violations.map(
      (v) =>
        `${v.id} [${v.impact ?? 'n/a'}] ${v.nodes.length}x: ${v.help} (${v.nodes
          .map((n) => n.target.join(' '))
          .join(', ')})`,
    ),
    `axe on ${label}`,
  ).toEqual([]);
}

async function csrf(page: Page): Promise<string> {
  const find = async () =>
    (await page.context().cookies()).find((c) => c.name === '__Host-csrf')?.value ?? '';
  if (!(await find())) await page.goto('/admin', { waitUntil: 'domcontentloaded' });
  return find();
}

/** Opens an admin page and waits until every island has hydrated. */
async function visit(page: Page, path: string) {
  const res = await page.goto(path);
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  return res;
}

interface Groups {
  today: string;
  counts: { overdue: number; today: number; upcoming: number; done: number };
  overdue: Task[];
  dueToday: Task[];
  upcoming: Task[];
  done: Task[];
}
interface Task {
  id: string;
  title: string;
  version: number;
  due_date: string;
  due_time: string;
  done_at: string | null;
}

async function groups(page: Page, query = 'view=all'): Promise<Groups> {
  const res = await page.request.get(`/api/admin/crm/tasks?${query}`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { data: Groups }).data;
}

const all = (g: Groups) => [...g.overdue, ...g.dueToday, ...g.upcoming, ...g.done];

/** A date `days` from a YYYY-MM-DD date (calendar arithmetic, no zone involved). */
function shift(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

async function addTask(page: Page, body: Record<string, unknown>): Promise<Task> {
  const res = await page.request.post('/api/admin/crm/tasks', {
    headers: { 'x-csrf-token': await csrf(page) },
    data: body,
  });
  expect(res.status(), JSON.stringify(body)).toBe(200);
  return ((await res.json()) as { data: Task }).data;
}

test.describe('as admin', () => {
  test.use({ storageState: authFile('admin') });
  test.describe.configure({ mode: 'serial' });

  test('the drawer adds a task at 10:00 by default, and it lands in its list', async ({ page }) => {
    await visit(page, '/admin/tasks');
    await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();
    const title = `E2E ${RUN} call back`;
    await page.getByRole('button', { name: 'New task' }).click();
    const drawer = page.getByRole('dialog', { name: 'New task' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByLabel('Time')).toHaveValue('10:00');
    await axe(page, '/admin/tasks with the drawer open');
    await drawer.getByLabel('What needs doing').fill(title);
    await drawer.getByLabel('Type').selectOption('call');
    const today = (await groups(page)).today;
    await drawer.getByLabel('Due date').fill(shift(today, 2));
    await drawer.getByRole('button', { name: 'Create task' }).click();
    await expect(drawer).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'Task added.' })).toBeVisible();
    const upcoming = page.locator('section[data-sec="upcoming"]');
    await expect(upcoming.getByText(title)).toBeVisible();
    const saved = all(await groups(page)).find((t) => t.title === title);
    expect(saved, 'the task is in the list the API answers').toBeTruthy();
    expect(saved!.due_time).toBe('10:00');
    expect(saved!.due_date).toBe(shift(today, 2));
    await axe(page, '/admin/tasks');
  });

  test('an overdue task of mine shows in Overdue, in words, and in the sidebar count', async ({
    page,
  }) => {
    const today = (await groups(page)).today;
    const title = `E2E ${RUN} overdue`;
    await addTask(page, {
      title,
      type: 'email',
      dueDate: shift(today, -1),
      dueTime: '09:00',
      ownerId: STAFF_IDS.admin,
    });
    await visit(page, '/admin/tasks?view=mine');
    const row = page.locator('section[data-sec="overdue"] li.task').filter({ hasText: title });
    await expect(row).toBeVisible();
    await expect(row.getByText('Overdue', { exact: true })).toBeVisible();
    const badge = page.locator('nav.admin-sidebar a[href="/admin/tasks"] .cnt');
    await expect(badge).toBeVisible();
    expect(Number.parseInt((await badge.innerText()) || '0', 10)).toBeGreaterThan(0);
    await expect(badge).toContainText('overdue');
  });

  test('ticking moves a task to Done; the snooze sets tomorrow 10:00', async ({ page }) => {
    const today = (await groups(page)).today;
    const tick = await addTask(page, {
      title: `E2E ${RUN} tick`,
      dueDate: shift(today, 3),
      dueTime: '15:00',
    });
    const later = await addTask(page, {
      title: `E2E ${RUN} snooze`,
      dueDate: shift(today, 5),
      dueTime: '15:00',
    });
    await visit(page, '/admin/tasks?view=all');
    await page.getByRole('checkbox', { name: tick.title }).check();
    await expect(page.getByRole('status').filter({ hasText: 'Task done.' })).toBeVisible();
    await expect
      .poll(async () => all(await groups(page)).find((t) => t.id === tick.id)?.done_at ?? null)
      .not.toBeNull();
    await expect(
      page.locator('details[data-sec="done"] li.task').filter({ hasText: tick.title }),
    ).toHaveCount(1);

    await page
      .locator(`#task-${later.id}`)
      .getByRole('button', { name: 'Snooze to tomorrow 10:00' })
      .click();
    await expect(page.getByRole('status').filter({ hasText: 'Snoozed' })).toBeVisible();
    const snoozed = all(await groups(page)).find((t) => t.id === later.id)!;
    expect(snoozed.due_date).toBe(shift(today, 1));
    expect(snoozed.due_time).toBe('10:00');
  });

  test('a stale version is a conflict; the calendar file carries the title and no note', async ({
    page,
  }) => {
    const today = (await groups(page)).today;
    const task = await addTask(page, {
      title: `E2E ${RUN} calendar, part 1`,
      dueDate: shift(today, 4),
      dueTime: '11:30',
      note: `secret note ${RUN}`,
    });
    const token = await csrf(page);
    const first = await page.request.patch(`/api/admin/crm/tasks/${task.id}`, {
      headers: { 'x-csrf-token': token },
      data: { version: task.version, title: `E2E ${RUN} calendar` },
    });
    expect(first.status()).toBe(200);
    const stale = await page.request.patch(`/api/admin/crm/tasks/${task.id}`, {
      headers: { 'x-csrf-token': token },
      data: { version: task.version, title: 'stale' },
    });
    expect(stale.status()).toBe(409);

    const ics = await page.request.get(`/api/admin/crm/tasks/${task.id}/ics`);
    expect(ics.status()).toBe(200);
    expect(ics.headers()['content-type']).toBe('text/calendar; charset=utf-8');
    expect(ics.headers()['content-disposition']).toMatch(
      /^attachment; filename="[a-z0-9-]+\.ics"$/,
    );
    expect(ics.headers()['cache-control']).toContain('no-store');
    expect(ics.headers()['x-content-type-options']).toBe('nosniff');
    const body = (await ics.text()).replace(/\r\n /g, '');
    expect(body).toContain(`SUMMARY:E2E ${RUN} calendar`);
    expect(body).toContain(`UID:${task.id}@`);
    expect(body).toContain(`/admin/tasks?view=all#task-${task.id}`);
    expect(body).not.toContain('secret note');
  });

  test('the drawer after someone else’s edit: the 409 shows the task as it is now, and the next Save goes through', async ({
    page,
  }) => {
    const today = (await groups(page)).today;
    const task = await addTask(page, {
      title: `E2E ${RUN} drawer race`,
      dueDate: shift(today, 6),
      dueTime: '14:00',
    });
    await visit(page, '/admin/tasks?view=all');
    await page.locator(`#task-${task.id}`).getByRole('button', { name: 'Edit this task' }).click();
    const drawer = page.getByRole('dialog', { name: 'Edit task' });
    await expect(drawer).toBeVisible();
    const what = drawer.getByLabel('What needs doing');
    await expect(what).toHaveValue(task.title);
    // Someone else saves first: the version the drawer read moves on.
    const theirs = `E2E ${RUN} drawer race, theirs`;
    const moved = await page.request.patch(`/api/admin/crm/tasks/${task.id}`, {
      headers: { 'x-csrf-token': await csrf(page) },
      data: { version: task.version, title: theirs },
    });
    expect(moved.status()).toBe(200);
    await what.fill(`E2E ${RUN} drawer race, lost`);
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      drawer.getByRole('alert').filter({ hasText: 'Someone else changed this. Refreshed.' }),
    ).toBeVisible();
    await expect(what).toHaveValue(theirs);
    // The next Save carries the new version: no second 409.
    const mine = `E2E ${RUN} drawer race, mine`;
    await what.fill(mine);
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
      .poll(async () => all(await groups(page)).find((t) => t.id === task.id)?.title ?? null)
      .toBe(mine);
    await expect(drawer.getByText('Someone else changed this.')).toHaveCount(0);
  });

  test('a lead’s page: the Tasks card adds a task about that lead', async ({ page }) => {
    const added = await page.request.post('/api/admin/leads', {
      headers: { 'x-csrf-token': await csrf(page) },
      data: {
        name: `E2E ${RUN} task lead`,
        message: 'A test inquiry for a task.',
        channel: 'phone',
        email: `task-${RUN}@example.invalid`,
      },
    });
    expect(added.status()).toBe(200);
    const leadId = ((await added.json()) as { data: { id: string } }).data.id;
    await visit(page, `/admin/leads/${leadId}`);
    const card = page.locator('section.card').filter({
      has: page.getByRole('heading', { level: 2, name: 'Tasks' }),
    });
    await expect(card).toBeVisible();
    await expect(card.getByText('No open tasks.')).toBeVisible();
    await card.getByRole('button', { name: 'Add a task' }).click();
    const drawer = page.getByRole('dialog', { name: 'New task' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText(/Lead #\d+/)).toBeVisible();
    const title = `E2E ${RUN} follow up the lead`;
    await drawer.getByLabel('What needs doing').fill(title);
    await drawer.getByRole('button', { name: 'Create task' }).click();
    await expect(drawer).toBeHidden();
    await expect(card.getByText(title)).toBeVisible();
    const mine = await groups(page, `lead=${leadId}`);
    expect(all(mine).map((t) => t.title)).toEqual([title]);
  });

  // Admin v2 C8b: the card C8 built to take a contact, mounted on C7's contact page.
  test('a contact’s page: the Tasks card adds a task about that contact', async ({ page }) => {
    const name = `E2E ${RUN} task contact`;
    const added = await page.request.post('/api/admin/crm/contacts', {
      headers: { 'x-csrf-token': await csrf(page) },
      data: { displayName: name },
    });
    expect(added.status()).toBe(200);
    const contactId = ((await added.json()) as { data: { id: string } }).data.id;
    await visit(page, `/admin/contacts/${contactId}`);
    const card = page.locator('section.card').filter({
      has: page.getByRole('heading', { level: 2, name: 'Tasks' }),
    });
    await expect(card).toBeVisible();
    await expect(card.getByText('Follow-ups for this person.')).toBeVisible();
    await expect(card.getByText('No open tasks.')).toBeVisible();
    await card.getByRole('button', { name: 'Add a task' }).click();
    const drawer = page.getByRole('dialog', { name: 'New task' });
    await expect(drawer).toBeVisible();
    // The contact is already chosen: their name, and a Remove button for it.
    await expect(drawer.getByText(name, { exact: true })).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Remove the contact' })).toBeVisible();
    await axe(page, 'the task drawer on a contact’s page');
    const title = `E2E ${RUN} follow up the contact`;
    await drawer.getByLabel('What needs doing').fill(title);
    await drawer.getByRole('button', { name: 'Create task' }).click();
    await expect(drawer).toBeHidden();
    await expect(card.getByText(title)).toBeVisible();
    const theirs = await groups(page, `contact=${contactId}`);
    expect(all(theirs).map((t) => t.title)).toEqual([title]);
    // The page read its timeline again: the task is a line on it (C8's event, in C7's words).
    const timeline = page.getByRole('list', { name: 'What happened, newest first' });
    await expect(timeline.getByText('Task added', { exact: true })).toBeVisible();
  });
});

// Admin v2 C10b: Sales holds crm.tasks.
test.describe('as sales', () => {
  test.use({ storageState: authFile('sales') });
  test.describe.configure({ mode: 'serial' });

  test('Tasks in the menu; a task of mine in My tasks, ticked off on the screen', async ({
    page,
  }) => {
    await visit(page, '/admin/tasks?view=mine');
    await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();
    await expect(page.locator('nav.admin-sidebar a[href="/admin/tasks"]')).toHaveCount(1);
    const today = (await groups(page, 'view=mine')).today;
    const task = await addTask(page, {
      title: `E2E ${RUN} sales follow-up`,
      type: 'call',
      dueDate: shift(today, 2),
      dueTime: '10:00',
      ownerId: STAFF_IDS.sales,
    });
    await visit(page, '/admin/tasks?view=mine');
    await expect(
      page.locator('section[data-sec="upcoming"] li.task').filter({ hasText: task.title }),
    ).toBeVisible();
    await axe(page, '/admin/tasks as Sales');
    await page.getByRole('checkbox', { name: task.title }).check();
    await expect(page.getByRole('status').filter({ hasText: 'Task done.' })).toBeVisible();
    await expect
      .poll(async () => all(await groups(page, 'view=mine')).find((t) => t.id === task.id)?.done_at)
      .toBeTruthy();
  });

  test('a task for a Developer is refused: an owner must hold crm.tasks', async ({ page }) => {
    const today = (await groups(page, 'view=mine')).today;
    const res = await page.request.post('/api/admin/crm/tasks', {
      headers: { 'x-csrf-token': await csrf(page) },
      data: {
        title: `E2E ${RUN} for a developer`,
        dueDate: shift(today, 2),
        dueTime: '10:00',
        ownerId: STAFF_IDS.developer,
      },
    });
    expect(res.status()).toBe(422);
    expect(all(await groups(page)).some((t) => t.title === `E2E ${RUN} for a developer`)).toBe(
      false,
    );
  });
});

for (const role of ['content_creator', 'seo', 'developer'] as const) {
  test.describe(`as ${role}`, () => {
    test.use({ storageState: authFile(role) });

    test('Tasks is refused by the server, and not in the menu', async ({ page }) => {
      const res = await visit(page, '/admin/tasks');
      expect(res?.status()).toBe(403);
      await expect(page.locator('main .msg[data-kind="error"]').first()).toContainText(
        'Your role does not allow that.',
      );
      expect(await page.content()).not.toContain(RUN);
      await expect(page.locator('nav.admin-sidebar a[href="/admin/tasks"]')).toHaveCount(0);
      const probe = '00000000-0000-4000-8000-000000000000';
      expect((await page.request.get('/api/admin/crm/tasks')).status()).toBe(403);
      expect((await page.request.get(`/api/admin/crm/tasks/${probe}/ics`)).status()).toBe(403);
      expect((await page.request.get(`/api/admin/crm/tasks/${probe}`)).status()).toBe(403);
      const post = await page.request.post('/api/admin/crm/tasks', {
        headers: { 'x-csrf-token': await csrf(page) },
        data: { title: 'x', dueDate: '2026-11-11', dueTime: '10:00' },
      });
      expect(post.status()).toBe(403);
    });
  });
}
