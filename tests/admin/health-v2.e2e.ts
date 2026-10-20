import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type { Role } from '@/lib/auth/types';
import { TENANT_ID } from '../../scripts/gen-seeds.mjs';
import { SKIP_REASON, authFile, staffEnv } from './staff';

// Site health v2 (Admin v2 G2) in a real browser, signed in. First the CI stack as it ships
// (no monitor key): the Uptime card says "Not set up", the tile too, and Check now renders as
// a 24px target (it is never clicked here: that would reach the network; unit tests cover it
// with a fetch mock). Then a configured state, written by THIS spec into the LOCAL Supabase
// only (staffEnv: a loopback URL, the service key, a preview built against it; never
// seed.sql, which also runs on staging): the 90-day strip and its table, the outages, the
// response chart, the Security tab's rows, the bell's "The site is down" for Admin and
// Developer only, axe and no overflow at 320, 390 and 1280. The rows are put back to "not
// set up" at the end (the service role holds no DELETE on health_probes).

const env = staffEnv();
test.skip(!env, SKIP_REASON);
test.describe.configure({ mode: 'serial' });
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const WIDTHS = [320, 390, 1280] as const;
const DAY = 86_400_000;

function service() {
  return createClient(env!.url, env!.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function writeProbes(rows: Record<string, unknown>[]) {
  const { error } = await service()
    .from('health_probes')
    .upsert(
      rows.map((row) => ({ tenant_id: TENANT_ID, ...row })),
      { onConflict: 'tenant_id,kind' },
    );
  if (error) throw new Error(`health_probes: ${error.message}`);
}

/** A down site with a month's history: what the screen shows once the monitor is set up. */
function configured(now: number) {
  const iso = (ms: number) => new Date(ms).toISOString();
  const days = Array.from({ length: 90 }, (_, i) => ({
    day: iso(now - (89 - i) * DAY).slice(0, 10),
    ratio: i === 60 ? 99.4 : i === 75 ? 96.1 : i === 89 ? 98.5 : 100,
  }));
  const at = iso(now);
  return [
    {
      kind: 'uptime',
      state: 'fail',
      read_ok: true,
      failures: 0,
      checked_at: at,
      ok_at: at,
      next_at: iso(now + 300_000),
      facts: {
        ratio30: 99.42,
        ratio90: 99.81,
        days,
        incidents: [
          {
            id: 'e2e-2',
            start: iso(now - 1_200_000),
            durationSec: 1200,
            reason: 'Connection timeout',
            seenAt: at,
          },
          {
            id: 'e2e-1',
            start: iso(now - 20 * DAY),
            durationSec: 420,
            reason: 'Server error 502',
            seenAt: iso(now - 20 * DAY),
          },
        ],
        responseTimes: Array.from({ length: 48 }, (_, i) => ({
          at: iso(now - (48 - i) * 3_600_000),
          ms: 180 + ((i * 37) % 90),
        })),
        monitors: [
          { name: 'Home', path: '/', intervalSec: 300, status: 'up' },
          { name: 'Arabic', path: '/ar/', intervalSec: 300, status: 'down' },
          { name: 'Health', path: '/healthz', intervalSec: 300, status: 'up' },
        ],
        downSince: iso(now - 1_200_000),
      },
    },
    {
      kind: 'domain',
      state: 'ok',
      read_ok: true,
      failures: 0,
      checked_at: at,
      ok_at: at,
      next_at: iso(now + 20 * 3_600_000),
      facts: {
        apex: 'braiinstatiion.com',
        outcome: 'ok',
        expires: iso(now + 200 * DAY + 3_600_000),
        registrar: 'Example Registrar',
        rdap: { tld: 'com', base: 'https://rdap.verisign.com/com/v1/', fetchedAt: at },
      },
    },
    {
      kind: 'certificate',
      state: 'fail',
      read_ok: true,
      failures: 0,
      checked_at: at,
      ok_at: at,
      next_at: iso(now + 300_000),
      facts: { source: 'monitor', expires: iso(now + 10 * DAY + 3_600_000), issuer: 'Example CA' },
    },
  ];
}

/** Back to how the CI stack ships: not set up, and no domain recorded. */
function notSetUp(now: number) {
  const at = new Date(now).toISOString();
  const base = { read_ok: false, failures: 0, checked_at: at, ok_at: null, next_at: null };
  return [
    { kind: 'uptime', state: 'off', facts: {}, ...base },
    { kind: 'certificate', state: 'off', facts: {}, ...base },
    {
      kind: 'domain',
      state: 'info',
      facts: { apex: null, outcome: 'not-applicable', expires: null, registrar: null, rdap: null },
      ...base,
      read_ok: true,
    },
  ];
}

async function open(page: Page, path: string) {
  const res = await page.goto(path, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  return res;
}

async function check(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect
    .soft(
      violations.map((v) => `${v.id} [${v.impact ?? 'n/a'}] ${v.nodes.length}x: ${v.help}`),
      `axe on ${label}`,
    )
    .toEqual([]);
  const overflow = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect.soft(overflow, `horizontal overflow on ${label}`).toBeLessThanOrEqual(2);
}

test.describe('not set up (the CI stack has no monitor key)', () => {
  test.use({ storageState: authFile('admin') });

  test.beforeAll(async () => {
    await writeProbes(notSetUp(Date.now()));
  });

  test('the Uptime card and tile say Not set up; Check now is a 24px target', async ({ page }) => {
    await open(page, '/admin/site-health');
    const card = page.locator('.card.upc');
    await expect(card.getByRole('heading', { name: 'Uptime' })).toBeVisible();
    await expect(
      card.getByText(/^Not set up\. Uptime comes from an external monitor/),
    ).toBeVisible();
    await expect(page.locator('.hs__i', { hasText: 'Uptime, 30 days' })).toContainText(
      'Not set up',
    );
    await expect(page.getByText(/Uptime is not set up yet\.$/)).toBeVisible();
    const button = page.getByRole('button', { name: 'Check now' });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(24);
  });

  test('the Security tab lists the protections, the domain and the certificate', async ({
    page,
  }) => {
    await open(page, '/admin/site-health?tab=security');
    await expect(
      page
        .getByRole('navigation', { name: 'Site health views' })
        .getByRole('link', { name: 'Security' }),
    ).toHaveAttribute('aria-current', 'page');
    const rows = page.locator('.hsrow .hsrow__t');
    await expect(rows).toHaveText([
      /Content Security Policy/,
      'Browsers always use HTTPS (HSTS, preload)',
      'The admin is never cached or indexed',
      'AI training crawlers are blocked',
      'Domain renewal: not checked: no domain is recorded for the site',
      'Certificates are issued and renewed by Cloudflare',
      // U17's row (security.two_step, users.manage: this is the Admin), after the website's.
      // A count, not a number: other specs add accounts while this one runs. Never "Everyone":
      // the four shared role accounts never set 2FA up (tests/admin/twoStep.e2e.ts uses an
      // account of its own), so at least four, and the plural.
      /^\d+ team members without two factor sign in$/,
    ]);
  });
});

test.describe('configured (fixture rows in the local Supabase)', () => {
  test.beforeAll(async () => {
    await writeProbes(configured(Date.now()));
  });
  test.afterAll(async () => {
    await writeProbes(notSetUp(Date.now()));
  });

  test('the strip, its table, the outages and the response chart', async ({ browser }) => {
    const context = await browser.newContext({ storageState: authFile('admin') });
    const page = await context.newPage();
    await open(page, '/admin/site-health');
    const card = page.locator('.card.upc');
    await expect(card.getByText('Checked every 5 minutes from outside our hosting')).toBeVisible();
    await expect(card.locator('.up .up__d')).toHaveCount(90);
    await expect(card.locator('.up .up__d[data-state="down"]')).toHaveCount(2);
    await expect(card.locator('.up .up__d[data-state="dip"]')).toHaveCount(1);
    // By its class: the text alone also matches the figure's visually hidden summary.
    await expect(card.locator('.up__sum')).toHaveText('Up all day on 87 of 90 days.');
    const strip = card.locator('#uptime-strip');
    await strip.getByText('View as table').click();
    await expect(strip.locator('tbody tr')).toHaveCount(3);
    await expect(card.getByText('Connection timeout')).toBeVisible();
    await expect(card.locator('#uptime-response svg')).toHaveCount(1);
    await expect(card.locator('.stat-row', { hasText: 'Now' })).toContainText('Down since');
    await expect(page.locator('.hs__i', { hasText: 'Uptime, 30 days' })).toContainText('99.42%');
    // Uptime is in the score. Its weight depends on the parts there are: the CI stack has no
    // vitals rollups with enough visits, so speed is left out and 40 / 40 / 20 becomes 67 / 33
    // (score.ts renormalises; tests/lib/healthScore.spec.ts pins the sentences).
    await expect(page.locator('.hs__f')).toHaveText(/uptime from the monitor( \(\d+%\)| alone)/i);
    await check(page, 'site health with readings, the table open');
    await open(page, '/admin/site-health?tab=security');
    await expect(page.getByText('braiinstatiion.com renews in 200 days')).toBeVisible();
    await expect(page.getByText('Certificate expires in 10 days')).toBeVisible();
    await context.close();
  });

  for (const role of ['admin', 'developer'] as Role[]) {
    for (const width of WIDTHS) {
      test(`as ${role} at ${width}px: axe zero, no overflow`, async ({ browser }) => {
        const context = await browser.newContext({ storageState: authFile(role) });
        const page = await context.newPage();
        await page.setViewportSize({ width, height: 900 });
        for (const path of ['/admin/site-health', '/admin/site-health?tab=security']) {
          const res = await open(page, path);
          expect(res?.status(), path).toBe(200);
          await check(page, `${path} as ${role} at ${width}px`);
        }
        await context.close();
      });
    }
  }

  test('the bell says the site is down to Admin and Developer only', async ({ browser }) => {
    for (const role of ['admin', 'developer', 'content_creator', 'seo'] as Role[]) {
      const context = await browser.newContext({ storageState: authFile(role) });
      const page = await context.newPage();
      await open(page, '/admin/notifications');
      const may = role === 'admin' || role === 'developer';
      await expect(page.getByText('The site is down', { exact: true }), role).toHaveCount(
        may ? 1 : 0,
      );
      await expect(page.getByText('The certificate expires in 10 days'), role).toHaveCount(
        may ? 1 : 0,
      );
      await context.close();
    }
  });
});
