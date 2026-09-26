import { defineConfig, devices } from '@playwright/test';

// E2E / accessibility runner (CLAUDE.md §9). Specs are named *.e2e.ts so vitest
// (tests/**/*.spec.ts) never picks them up. Runs against a built+served preview (the
// Worker under `wrangler dev`, reading a seeded local Supabase) — the perf-seo-a11y
// workflow, on every push and PR since 2026-09-25.
//
// Locally: `npm run build && node scripts/local-preview-config.mjs && npx wrangler dev
// --port 8788`, then `npm run test:e2e` (PREVIEW_URL overrides the target).
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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
