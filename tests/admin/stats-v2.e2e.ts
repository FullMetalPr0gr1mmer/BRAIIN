import { expect, test, type Page } from '@playwright/test';
import { ROLE_CAPS } from '@/lib/authz/matrix';
import type { Role } from '@/lib/auth/types';
import { SKIP_REASON, STAFF_ROLES, authFile, staffEnv } from './staff';

// Website stats v2 (Admin v2 G1) in a real browser, signed in, past what the view sweep in
// stats-health.e2e.ts already checks (every tab, every role, axe and no overflow at 320, 390
// and 1280px):
//   - Conversions: the funnel is drawn in words, and "Inquiries received" shows only to the
//     roles that work with leads (Admin, Developer);
//   - Realtime: the island asks again once a minute, Pause stops it (counted on the route, on
//     a fake clock), Resume asks at once and goes on;
//   - Goals: Admin adds, edits and deletes one through the kit's Drawer and Modal, SEO adds
//     one, and Content Creator and Developer see the list with no controls and get the
//     server's 403 when they write through the API directly (CSRF and origin valid, so the
//     capability is the only thing left to refuse it).

test.skip(!staffEnv(), SKIP_REASON);
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const RUN = Date.now().toString(36);

async function open(page: Page, path: string) {
  const res = await page.goto(path, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  return res;
}

async function csrfOf(page: Page): Promise<string> {
  const token = await page.locator('meta[name="csrf-token"]').getAttribute('content');
  expect(token, 'the admin layout carries a CSRF token').toBeTruthy();
  return token!;
}

const worksLeads = (role: Role) => ROLE_CAPS[role]['leads.manage'] === 'full';
const setsGoals = (role: Role) => ROLE_CAPS[role]['analytics.goals'] === 'full';

for (const role of STAFF_ROLES) {
  test.describe(`Conversions as ${role}`, () => {
    test.use({ storageState: authFile(role) });

    test('the funnel in words; inquiries only for lead roles; goal controls only for goal setters', async ({
      page,
    }) => {
      const res = await open(page, '/admin/analytics?tab=conversions&range=90');
      expect(res?.status()).toBe(200);
      const funnel = page.getByRole('heading', { name: 'Funnel' });
      await expect(funnel).toBeVisible();
      // Either the three steps or the honest empty state, never a blank card.
      const steps = page.locator('.fun-list > li');
      const empty = page.getByText('No visits counted in this period.');
      await expect(steps.or(empty).first()).toBeVisible();
      if ((await steps.count()) > 0) {
        await expect(steps).toHaveCount(3);
        await expect(steps.nth(0)).toContainText('Visited the site');
        await expect(steps.nth(2)).toContainText('Reached an inquiry form');
        await expect(page.getByText('Inquiries received', { exact: true })).toHaveCount(
          worksLeads(role) ? 1 : 0,
        );
      }
      await expect(page.getByRole('button', { name: 'Add goal' })).toHaveCount(
        setsGoals(role) ? 1 : 0,
      );
    });

    if (!setsGoals(role)) {
      test('writing a goal through the API is refused by the server', async ({ page }) => {
        await open(page, '/admin/analytics?tab=conversions');
        const headers = {
          'x-csrf-token': await csrfOf(page),
          origin: new URL(page.url()).origin,
        };
        const created = await page.request.post('/api/admin/analytics/goals', {
          headers,
          data: { name: `Refused ${RUN}`, metric: 'visits', cta: null, target: 10 },
        });
        expect(created.status()).toBe(403);
        expect(await created.json()).toMatchObject({ ok: false, error: 'forbidden' });
        // Reading them is every analytics.read role's.
        const list = await page.request.get('/api/admin/analytics/goals');
        expect(list.status()).toBe(200);
      });
    }
  });
}

test.describe('Realtime', () => {
  test.use({ storageState: authFile('content_creator') });

  test('asks once a minute; Pause stops it; Resume asks at once and goes on', async ({ page }) => {
    await page.clock.install();
    let asked = 0;
    page.on('request', (req) => {
      if (new URL(req.url()).pathname === '/api/admin/analytics/realtime') asked += 1;
    });
    await open(page, '/admin/analytics?tab=realtime');
    await expect(page.getByText('on the site right now')).toBeVisible();
    await expect(page.getByText('Updates every minute.')).toBeVisible();
    expect(asked).toBe(0); // the first figures are the server's

    await page.clock.runFor(61_000);
    await expect.poll(() => asked).toBe(1);

    await page.getByRole('button', { name: 'Pause updates' }).click();
    await expect(page.getByText('Updates paused.')).toBeVisible();
    await page.clock.runFor(180_000);
    expect(asked).toBe(1);

    await page.getByRole('button', { name: 'Resume updates' }).click();
    await expect.poll(() => asked).toBe(2);
    await page.clock.runFor(61_000);
    await expect.poll(() => asked).toBe(3);
  });

  test('stops by itself after 30 minutes, and says so', async ({ page }) => {
    await page.clock.install();
    await open(page, '/admin/analytics?tab=realtime');
    await page.clock.runFor(31 * 60_000);
    await expect(page.getByText('Updates paused after 30 minutes.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resume updates' })).toBeVisible();
  });
});

test.describe('Goals', () => {
  test('Admin adds, edits and deletes a goal through the drawer and the modal', async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: authFile('admin') });
    const page = await context.newPage();
    const name = `WhatsApp clicks ${RUN}`;
    await open(page, '/admin/analytics?tab=conversions');

    await page.getByRole('button', { name: 'Add goal' }).click();
    const drawer = page.getByRole('dialog', { name: 'New goal' });
    await expect(drawer).toBeVisible();
    // The form refuses an empty name before asking the server.
    await drawer.getByRole('button', { name: 'Add goal' }).click();
    await expect(drawer.getByText('Name the goal').first()).toBeVisible();
    await drawer.getByLabel('Goal name').fill(name);
    await drawer.getByLabel('Counts').selectOption('cta');
    await drawer.getByLabel('Which click').selectOption('whatsapp');
    await drawer.getByLabel('Target').fill('40');
    await drawer.getByRole('button', { name: 'Add goal' }).click();
    await page.waitForURL(/tab=conversions/);
    await expect(page.getByText('Goal added')).toBeVisible();
    const row = page.locator('.goal', { hasText: name });
    await expect(row).toContainText('Clicks: WhatsApp click');
    await expect(row).toContainText('of 40');

    await row.getByRole('button', { name: `Edit ${name}` }).click();
    const edit = page.getByRole('dialog', { name: 'Edit goal' });
    await edit.getByLabel('Target').fill('80');
    await edit.getByRole('button', { name: 'Save goal' }).click();
    await expect(page.getByText('Goal saved')).toBeVisible();
    await expect(page.locator('.goal', { hasText: name })).toContainText('of 80');

    await page
      .locator('.goal', { hasText: name })
      .getByRole('button', { name: `Delete ${name}` })
      .click();
    const confirm = page.getByRole('dialog', { name: 'Delete this goal?' });
    await confirm.getByRole('button', { name: 'Delete goal' }).click();
    await expect(page.getByText('Goal deleted')).toBeVisible();
    await expect(page.locator('.goal', { hasText: name })).toHaveCount(0);
    await context.close();
  });

  test('SEO adds a goal, and deletes it again', async ({ browser }) => {
    const context = await browser.newContext({ storageState: authFile('seo') });
    const page = await context.newPage();
    const name = `Visits ${RUN}`;
    await open(page, '/admin/analytics?tab=conversions');
    await page.getByRole('button', { name: 'Add goal' }).click();
    const drawer = page.getByRole('dialog', { name: 'New goal' });
    await drawer.getByLabel('Goal name').fill(name);
    await drawer.getByLabel('Target').fill('500');
    await drawer.getByRole('button', { name: 'Add goal' }).click();
    await expect(page.getByText('Goal added')).toBeVisible();
    const row = page.locator('.goal', { hasText: name });
    await expect(row).toContainText('Visits');
    await row.getByRole('button', { name: `Delete ${name}` }).click();
    await page
      .getByRole('dialog', { name: 'Delete this goal?' })
      .getByRole('button', { name: 'Delete goal' })
      .click();
    await expect(page.locator('.goal', { hasText: name })).toHaveCount(0);
    await context.close();
  });
});
