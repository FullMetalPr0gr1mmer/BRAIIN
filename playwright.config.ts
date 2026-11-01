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
// Google Analytics 4 (Admin v2 U15) saves a measurement id, which puts the loader on every public
// page the other specs read (the CI e2e build turns GA4_NOTICE_READY on): its own project, after
// general settings and before maintenance.
const GA4_SPEC = /[\\/]tests[\\/]admin[\\/]ga4\.e2e\.ts$/;
const MAINTENANCE_SPEC = /[\\/]tests[\\/]admin[\\/]maintenance\.e2e\.ts$/;
// The section blocks (Admin v2 E10) put a Text block, a Gallery and a Video on About, a page
// the public and the admin specs read (pages.e2e.ts counts its sections), and remove them when
// they end: their own project, after the public and the admin specs, before page visibility.
// Written for releases off, so the rehearsal (E2E_RELEASES=on) has no such project.
const BLOCKS_SPEC = /[\\/]tests[\\/]admin[\\/]section-blocks\.e2e\.ts$/;
// The release-mode rehearsal (Admin v2 R14-prep; .github/workflows/releases-rehearsal.yml, plan
// B5): with E2E_RELEASES=on the whole suite runs with releases switched ON for the e2e tenant.
// `releases-on` (tests/admin/releases.setup.ts) runs `app.enable_releases` as the owner after the
// sample rows and before every public and admin spec; `releases-mode` (the publish, scheduled
// release and rollback drill) runs alone after them, because Publish puts every selected change
// live. Unset (the required e2e job, every PR) the projects are exactly what they were:
// tests/ci/releasesRehearsal.spec.ts holds both shapes.
const RELEASES = process.env['E2E_RELEASES'] === 'on';
const RELEASES_MODE_SPEC = /[\\/]tests[\\/]admin[\\/]releases-mode\.e2e\.ts$/;
const releaseProjects = RELEASES
  ? [
      {
        name: 'releases-on',
        testDir: './tests/admin',
        testMatch: /releases\.setup\.ts$/,
        use: { ...devices['Desktop Chrome'] },
        dependencies: ['admin-samples'],
      },
      {
        name: 'releases-mode',
        testDir: './tests/admin',
        testMatch: RELEASES_MODE_SPEC,
        use: { ...devices['Desktop Chrome'] },
        dependencies: ['chromium', 'admin'],
      },
    ]
  : [];

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
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: ADMIN_SPECS,
      ...(RELEASES ? { dependencies: ['releases-on'] } : {}),
    },
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
      testIgnore: [
        VISIBILITY_SPEC,
        GENERAL_SPEC,
        GA4_SPEC,
        MAINTENANCE_SPEC,
        /maintenance\.teardown\.ts$/,
        RELEASES_MODE_SPEC,
        BLOCKS_SPEC,
      ],
      use: { ...devices['Desktop Chrome'] },
      dependencies: [RELEASES ? 'releases-on' : 'admin-samples'],
    },
    ...releaseProjects,
    ...(RELEASES
      ? []
      : [
          {
            name: 'blocks',
            testDir: './tests/admin',
            testMatch: BLOCKS_SPEC,
            use: { ...devices['Desktop Chrome'] },
            dependencies: ['chromium', 'admin'],
          },
        ]),
    {
      // Page visibility (Admin v2 U14a) hides real pages on the one preview every spec
      // shares, so it runs alone, after the public and the admin specs (and restores every
      // page to public when it ends).
      name: 'visibility',
      testDir: './tests/admin',
      testMatch: VISIBILITY_SPEC,
      use: { ...devices['Desktop Chrome'] },
      dependencies: RELEASES ? ['releases-mode'] : ['blocks'],
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
      // GA4 (Admin v2 U15) saves an id, so every public page carries the loader and lists
      // Google's hosts while it runs: alone, after the specs that read those pages, and it
      // clears the id when it ends.
      name: 'ga4',
      testDir: './tests/admin',
      testMatch: GA4_SPEC,
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['general'],
    },
    {
      // Maintenance (Admin v2 U9b) takes the shared preview down: last of all, and its
      // teardown switches it off whatever happened.
      name: 'maintenance',
      testDir: './tests/admin',
      testMatch: MAINTENANCE_SPEC,
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['ga4'],
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
