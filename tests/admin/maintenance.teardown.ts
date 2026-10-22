import { expect, test } from '@playwright/test';
import { SKIP_REASON, authFile, staffEnv } from './staff';

// The `maintenance` project's teardown (playwright.config.ts): whatever happened in
// tests/admin/maintenance.e2e.ts, the shared preview ends with maintenance OFF, through the
// same route a person uses (the row first, then the edge), so a crashed run never leaves the
// site down for a retry or a later job.

test.skip(!staffEnv(), SKIP_REASON);
test.use({ storageState: authFile('admin') });

test('maintenance is off', async ({ page }) => {
  await page.goto('/admin', { waitUntil: 'networkidle' });
  const token = await page.locator('meta[name="csrf-token"]').getAttribute('content');
  const api = '/api/admin/settings/maintenance';
  const current = await page.request.get(api);
  expect(current.status()).toBe(200);
  const { version } = ((await current.json()) as { data: { version: number } }).data;
  const res = await page.request.patch(api, {
    headers: { 'x-csrf-token': token ?? '', origin: new URL(page.url()).origin },
    data: { active: false, allowlist: [], until: null, title: null, message: null, version },
  });
  expect(res.status(), await res.text()).toBe(200);
  expect((await page.request.get('/', { maxRedirects: 0 })).status()).not.toBe(503);
});
