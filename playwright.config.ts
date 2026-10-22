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
// preview are loopback, the service key is exported, and the build in dist/ names that same
// Supabase (tests/admin/staff.ts); in CI the setup fails instead of skipping.
const ADMIN_SPECS = /[\\/]tests[\\/]admin[\\/]/;
// Page visibility (Admin v2 U14a) hides real pages: its own project, run last (below).
const VISIBILITY_SPEC = /[\\/]tests[\\/]admin[\\/]visibility\.e2e\.ts$/;
// General settings (Admin v2 U9) changes the public identity every spec reads, and maintenance
// (U9b) takes the site down: each its own project, after page visibility, in that order.
const GENERAL_SPEC = /[\\/]tests[\\/]admin[\\/]general\.e2e\.ts$/;
const MAINTENANCE_SPEC = /[\\/]tests[\\/]admin[\\/]maintenance\.e2e\.ts$/;

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
      // The F0 harness extension (Admin v2 C4b): a row for each edit screen with no resource
      // config (tests/admin/routes.ts EDIT_SAMPLES), added as the admin once the sessions
      // exist, before the sweep looks for one.
      name: 'admin-samples',
      testDir: './tests/admin',
      testMatch: /samples\.setup\.ts$/,
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['admin-setup'],
    },
    {
      name: 'admin',
      testDir: './tests/admin',
      testIgnore: [VISIBILITY_SPEC, GENERAL_SPEC, MAINTENANCE_SPEC, /maintenance\.teardown\.ts$/],
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['admin-samples'],
    },
    {
      // Page visibility (Admin v2 U14a) hides real pages on the one preview every spec
      // shares, so it runs alone, after the public and the admin specs (and restores every
      // page to public when it ends).
      name: 'visibility',
      testDir: './tests/admin',
      testMatch: VISIBILITY_SPEC,
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['chromium', 'admin'],
    },
    {
      // General settings (Admin v2 U9) edits the public identity (a tagline, a hidden social
      // account, the icons) and the studio's zone, then puts them back: alone, after the
      // public specs that read them.
      name: 'general',
      testDir: './tests/admin',
      testMatch: GENERAL_SPEC,
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['visibility'],
    },
    {
      // Maintenance (Admin v2 U9b) takes the shared preview down: last of all, and its
      // teardown switches it off whatever happened.
      name: 'maintenance',
      testDir: './tests/admin',
      testMatch: MAINTENANCE_SPEC,
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['general'],
      teardown: 'maintenance-teardown',
    },
    {
      name: 'maintenance-teardown',
      testDir: './tests/admin',
      testMatch: /maintenance\.teardown\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
