import { defineConfig, devices } from '@playwright/test';

// E2E / accessibility runner (CLAUDE.md §9). Specs are named *.e2e.ts so vitest
// (tests/**/*.spec.ts) never picks them up. Runs against a built+served preview (the
// Worker under `wrangler dev`, reading a seeded local Supabase) — the perf-seo-a11y
// workflow, on every push and PR since 2026-09-25.
//
// Locally: `npm run build && node scripts/local-preview-config.mjs && npx wrangler dev
// --port 8788`, then `npm run test:e2e` (PREVIEW_URL overrides the target).
//
// Admin specs (tests/admin, Admin v2 F0) run signed in. `admin-setup` creates one staff
// account per role on the LOCAL Supabase and saves each role's session; `admin` depends on
// it and opens contexts from those sessions. Both skip unless the Supabase URL and the
// preview are loopback and the service key is exported (tests/admin/staff.ts).
const ADMIN_SPECS = /[\\/]tests[\\/]admin[\\/]/;

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'line',
  use: {
    baseURL: process.env.PREVIEW_URL ?? 'http://localhost:8788',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: ADMIN_SPECS },
    {
      name: 'admin-setup',
      testDir: './tests/admin',
      testMatch: /staff\.setup\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'admin',
      testDir: './tests/admin',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['admin-setup'],
    },
  ],
});
