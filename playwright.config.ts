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
// The header's options (Admin v2 E5) change the bar on every public page (its markup, its
// height): its own project, after general settings.
const HEADER_SPEC = /[\\/]tests[\\/]admin[\\/]header\.e2e\.ts$/;
// The footer (Admin v2 E6) saves its basics and a column every public page then draws: its own
// project, after the header.
const FOOTER_SPEC = /[\\/]tests[\\/]admin[\\/]footer\.e2e\.ts$/;
// The loading screen (Admin v2 E7) saves a look the home page's intro then draws, and turns the
// intro off and on: its own project, after the footer.
const LOADING_SPEC = /[\\/]tests[\\/]admin[\\/]loading\.e2e\.ts$/;
// Google Analytics 4 (Admin v2 U15) saves a measurement id, which puts the loader on every public
// page the other specs read (the CI e2e build turns GA4_NOTICE_READY on): its own project, after
// general settings and before maintenance.
const GA4_SPEC = /[\\/]tests[\\/]admin[\\/]ga4\.e2e\.ts$/;
// The theme (Admin v2 E4) saves colours every public page then draws: its own project, after GA4
// and before maintenance, and it puts the brand's own theme back when it ends.
const THEME_SPEC = /[\\/]tests[\\/]admin[\\/]theme\.e2e\.ts$/;
// The template editors (Admin v2 E3) save shared text every service page then shows: their own
// project, after the theme and before maintenance, and they remove the row when they end.
const TEMPLATES_SPEC = /[\\/]tests[\\/]admin[\\/]templates\.e2e\.ts$/;
const MAINTENANCE_SPEC = /[\\/]tests[\\/]admin[\\/]maintenance\.e2e\.ts$/;
// The section blocks (Admin v2 E10) put a Text block, a Gallery and a Video on About, a page
// the public and the admin specs read (pages.e2e.ts counts its sections), and remove them when
// they end: their own project, after the public and the admin specs, before page visibility.
// Admin v2 E9's section appearance spec joins it, for the same reason: it publishes a page of its
// own, which the sitemap and the link picker every other spec may read would then list. In both
// modes since Admin v2 R14b: with E2E_RELEASES=on it runs after the drill (`releases-mode`), as
// page visibility did, and publishes only its own sections.
const BLOCKS_SPEC = /[\\/]tests[\\/]admin[\\/]section-(?:blocks|appearance)\.e2e\.ts$/;
// Release mode (Admin v2 R14-prep's rehearsal, plan B5; since R14c the required e2e job,
// perf-seo-a11y.yml `e2e`): with E2E_RELEASES=on the whole suite runs with releases switched ON
// for the e2e tenant.
// `releases-on` (tests/admin/releases.setup.ts) runs `app.enable_releases` as the owner after the
// sample rows and before every public and admin spec; `releases-mode` (the publish, scheduled
// release and rollback drill) runs alone after them, because Publish puts every selected change
// live. Unset (the releases-off job, `e2e-releases-off`) the projects are exactly what they were:
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

// Admin visual baselines (Admin v2 Z1, ui.md AV-34): with ADMIN_VISUAL set (`update` or
// `compare`, only by the hand-run .github/workflows/admin-visual.yml) one more project,
// `admin-visual`, takes tests/visual/admin.visual.ts's pictures right after the sample rows, before
// any spec writes, against baselines under tests/visual/admin-baselines/<platform>/. The file
// ends in `.ts`, so no other project collects it. Unset (the e2e jobs, every PR) the
// projects are exactly what they were (tests/ci/adminVisual.spec.ts holds both shapes). With
// E2E_RELEASES=on as well (the workflow's env is the e2e job's, so from R14c's flip) it waits for
// the switch instead, so every picture is of release mode, never of a tenant switching on.
const ADMIN_VISUAL = ['update', 'compare'].includes(process.env['ADMIN_VISUAL'] ?? '');
const adminVisualProjects = ADMIN_VISUAL
  ? [
      {
        name: 'admin-visual',
        testDir: './tests/visual',
        testMatch: /admin\.visual\.ts$/,
        snapshotPathTemplate: '{testDir}/admin-baselines/{platform}/{arg}{ext}',
        use: { ...devices['Desktop Chrome'] },
        dependencies: [RELEASES ? 'releases-on' : 'admin-samples'],
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
        HEADER_SPEC,
        FOOTER_SPEC,
        LOADING_SPEC,
        GA4_SPEC,
        THEME_SPEC,
        TEMPLATES_SPEC,
        MAINTENANCE_SPEC,
        /maintenance\.teardown\.ts$/,
        RELEASES_MODE_SPEC,
        BLOCKS_SPEC,
      ],
      use: { ...devices['Desktop Chrome'] },
      dependencies: [RELEASES ? 'releases-on' : 'admin-samples'],
    },
    ...releaseProjects,
    ...adminVisualProjects,
    {
      name: 'blocks',
      testDir: './tests/admin',
      testMatch: BLOCKS_SPEC,
      use: { ...devices['Desktop Chrome'] },
      // Releases on (the required e2e job since R14c): after the drill, which publishes every
      // change it selects.
      dependencies: RELEASES ? ['releases-mode'] : ['chromium', 'admin'],
    },
    {
      // Page visibility (Admin v2 U14a) hides real pages on the one preview every spec
      // shares, so it runs alone, after the public and the admin specs (and restores every
      // page to public when it ends).
      name: 'visibility',
      testDir: './tests/admin',
      testMatch: VISIBILITY_SPEC,
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['blocks'],
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
      // The header's options (Admin v2 E5): a large logo, the links moved and a button on every
      // public page while it runs, then the row removed (the header as built): alone, after
      // general settings.
      name: 'header',
      testDir: './tests/admin',
      testMatch: HEADER_SPEC,
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['general'],
    },
    {
      // The footer (Admin v2 E6): the dark style, a template, the mailbox hidden, the icons and
      // a column on every public page while it runs, then all of it put back: alone, after the
      // header.
      name: 'footer',
      testDir: './tests/admin',
      testMatch: FOOTER_SPEC,
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['header'],
    },
    {
      // The loading screen (Admin v2 E7): a black plate with a bar and a tagline, then a light
      // one, on the home page while it runs, and the intro turned off and on; then the row
      // removed and the home hero put back: alone, after the footer.
      name: 'loading',
      testDir: './tests/admin',
      testMatch: LOADING_SPEC,
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['footer'],
    },
    {
      // GA4 (Admin v2 U15) saves an id, so every public page carries the loader and lists
      // Google's hosts while it runs: alone, after the specs that read those pages, and it
      // clears the id when it ends.
      name: 'ga4',
      testDir: './tests/admin',
      testMatch: GA4_SPEC,
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['loading'],
    },
    {
      // The theme (Admin v2 E4) saves colours every public page draws, so the axe and CSP
      // checks of the other specs would read a themed site: alone, after GA4, and it saves the
      // brand's own theme back when it ends (no token: no page links a stylesheet).
      name: 'theme',
      testDir: './tests/admin',
      testMatch: THEME_SPEC,
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['ga4'],
    },
    {
      // The template editors (Admin v2 E3) save a line of the service template's shared text,
      // which every service page shows while it runs: alone, after the theme, and the row is
      // removed when it ends (no row: the templates as built).
      name: 'templates',
      testDir: './tests/admin',
      testMatch: TEMPLATES_SPEC,
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['theme'],
    },
    {
      // Maintenance (Admin v2 U9b) takes the shared preview down: last of all, and its
      // teardown switches it off whatever happened.
      name: 'maintenance',
      testDir: './tests/admin',
      testMatch: MAINTENANCE_SPEC,
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['templates'],
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
