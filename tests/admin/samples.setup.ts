import { expect, test as setup, type Page } from '@playwright/test';
import { EDIT_SAMPLES } from './routes';
import { SKIP_REASON, authFile, staffEnv } from './staff';

/*
 * The F0 harness extension (Admin v2 C4b): a row for every edit screen that has no resource
 * config, so the per-role sweep has something to open (tests/admin/routes.ts EDIT_SAMPLES,
 * read by sweep.e2e.ts). Signed in as the admin (staff.setup.ts saved the session; this
 * project runs after it), each sample's list is asked for one row; when it answers none, the
 * sample's own create route adds one, through the real Worker: its Zod, its capability, its
 * audit row. Idempotent: a second run finds the row and adds nothing.
 *
 * LOCAL STACKS ONLY, by the same guard as the staff accounts (tests/admin/staff.ts
 * staffEnv: a loopback Supabase and preview, and a build that names that Supabase). Never a
 * seed row: supabase/seed.sql also runs on staging, and a lead's e-mail needs ciphertext
 * under the real key. The sample's address is on `.invalid`, which no mail ever reaches.
 */

const env = staffEnv();
setup.skip(!env && !process.env['CI'], SKIP_REASON);
setup.use({ storageState: authFile('admin') });

/** The double-submit token the admin's own fetches send (the `__Host-csrf` cookie). */
async function csrf(page: Page): Promise<string> {
  await page.goto('/admin', { waitUntil: 'domcontentloaded' });
  const token = (await page.context().cookies()).find((c) => c.name === '__Host-csrf')?.value;
  expect(token, 'the admin session carries a CSRF cookie').toBeTruthy();
  return token!;
}

for (const [pattern, sample] of Object.entries(EDIT_SAMPLES)) {
  setup(`a row for ${pattern}`, async ({ page }) => {
    expect(env, `CI must run the admin harness: ${SKIP_REASON}`).not.toBeNull();
    const headers = { 'x-csrf-token': await csrf(page) };
    const list = await page.request.post(sample.api, { headers, data: sample.body });
    expect(list.status(), `${sample.api} answers the admin`).toBe(200);
    const found = ((await list.json()) as { data?: { rows?: { id?: unknown }[] } }).data?.rows;
    if (typeof found?.[0]?.id === 'string') return;

    const added = await page.request.post(sample.create.api, {
      headers,
      data: sample.create.body,
    });
    expect(added.status(), `${sample.create.api} adds the sample`).toBe(200);
    const again = await page.request.post(sample.api, { headers, data: sample.body });
    const rows = ((await again.json()) as { data?: { rows?: { id?: unknown }[] } }).data?.rows;
    expect(typeof rows?.[0]?.id, `${sample.api} now answers a row`).toBe('string');
  });
}
