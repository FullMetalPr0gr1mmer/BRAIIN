import { expect, test, type Page } from '@playwright/test';
import { ROLE_CAPS } from '@/lib/authz/matrix';
import { SKIP_REASON, STAFF_ROLES, authFile, staffEnv } from './staff';
import { LOCKED_SCREENS, refusedRoles } from './routes';

/*
 * The server's refusals, end to end (CLAUDE.md §9: "Negative E2E proves server 403, not
 * just a hidden button"). The sweep opens only what each role's menu offers; this opens
 * what it does not, through the real Worker, session and access-token hook.
 *
 *   signed in   each screen in LOCKED_SCREENS, as every role without its capability: the
 *               API its island loads answers assertCap's 403 (`forbidden`, not a CSRF or
 *               origin refusal), and the screen shows that refusal rather than data. The
 *               middleware asks only for a session, so the page itself still renders.
 *   writes      creating a service as a role without `services.write`, with a valid CSRF
 *               token and origin, so the only thing left to refuse it is the capability.
 *   signed out  every locked screen sends a visitor to sign in, its API answers 401.
 *
 * Not here: `other_tenant` (the harness has one tenant; the tenant predicate is proven in
 * pgTAP and tests/authz/endpoints.spec.ts) and a demotion mid-session (the claims check
 * compares the profile with getUser()'s fresh app_metadata, which a demotion through the
 * users API updates too, so editing the profile alone would test a path no one takes).
 */

test.skip(!staffEnv(), SKIP_REASON);

const REFUSAL = 'Your role does not allow that.';

/** The CSRF double-submit token the layout hands the page, for a hand-made mutation. */
async function csrfOf(page: Page): Promise<string> {
  const token = await page.locator('meta[name="csrf-token"]').getAttribute('content');
  expect(token, 'the admin layout carries a CSRF token').toBeTruthy();
  return token!;
}

for (const role of STAFF_ROLES) {
  const locked = LOCKED_SCREENS.filter((screen) => refusedRoles(screen).includes(role));
  if (locked.length === 0) continue;

  test.describe(`as ${role}`, () => {
    test.use({ storageState: authFile(role) });

    for (const screen of locked) {
      test(`${screen.href} is refused by the server`, async ({ page }) => {
        const res = await page.request.get(screen.api);
        expect(res.status(), `${screen.api} as ${role}`).toBe(403);
        expect(await res.json()).toMatchObject({ ok: false, error: 'forbidden' });

        const refused = page.waitForResponse(
          (r) => new URL(r.url()).pathname === screen.api && r.status() === 403,
        );
        await page.goto(screen.href);
        await refused;
        await expect(page.locator('main .msg[data-kind="error"]').first()).toContainText(REFUSAL);
      });
    }
  });
}

for (const role of STAFF_ROLES.filter((r) => ROLE_CAPS[r]['services.write'] === 'none')) {
  test.describe(`as ${role}, writing`, () => {
    test.use({ storageState: authFile(role) });

    test('creating a service is refused by the server', async ({ page }) => {
      await page.goto('/admin', { waitUntil: 'networkidle' });
      const res = await page.request.post('/api/admin/services', {
        headers: { 'x-csrf-token': await csrfOf(page), origin: new URL(page.url()).origin },
        data: { slug: 'e2e-refused', title: { en: 'Refused', ar: 'مرفوض' }, status: 'draft' },
      });
      expect(res.status(), `POST /api/admin/services as ${role}`).toBe(403);
      expect(await res.json()).toMatchObject({ ok: false, error: 'forbidden' });
    });
  });
}

test.describe('signed out', () => {
  for (const screen of LOCKED_SCREENS) {
    test(`${screen.href} sends a visitor to sign in; its API answers 401`, async ({ page }) => {
      await page.goto(screen.href);
      const url = new URL(page.url());
      expect(url.pathname).toBe('/admin/login');
      expect(url.searchParams.get('next')).toBe(screen.href);

      const res = await page.request.get(screen.api);
      expect(res.status(), screen.api).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: 'unauthenticated' });
    });
  }
});
