import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, test as setup } from '@playwright/test';
import { SKIP_REASON, STAFF_ROLES, authFile, ensureStaff, staffEnv } from './staff';

/*
 * Signs each role in once and saves its session for the `admin` project
 * (playwright.config.ts). Through the real login form, so the `__Host-csrf` double submit,
 * the lockout check, the access-token hook and resolveAuthContext's claims-vs-profile
 * check all run exactly as they do for a person. Every admin spec then opens a context
 * from the saved state (test.use({ storageState })) instead of signing in again.
 *
 * One session per role is shared by the whole run. That holds while the run is shorter
 * than the access token's lifetime (an hour): a refresh rotates the refresh token, and the
 * other contexts would then present a spent one.
 */

const env = staffEnv();
setup.skip(!env, SKIP_REASON);

for (const role of STAFF_ROLES) {
  setup(`sign in as ${role}`, async ({ browser }) => {
    const { email, password } = await ensureStaff(env!, role);
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('/admin/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => url.pathname === '/admin');
    // The account menu prints the role the SERVER resolved, so a session that signed in
    // but came back as another role (a stale hook, a wrong profile) fails here.
    await expect(page.locator('.account-menu .menu-id')).toContainText(role.replace('_', ' '));

    mkdirSync(dirname(authFile(role)), { recursive: true });
    await context.storageState({ path: authFile(role) });
    await context.close();
  });
}
