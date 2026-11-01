import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { RECRUITMENT_POLICY_VERSION } from '@consent/recruitment';
import { SKIP_REASON, authFile, staffEnv } from './staff';

/*
 * The Forms overview (Admin v2 U11, /admin/forms), signed in as Developer (settings.general;
 * Admin is swept, Content Creator, SEO and Sales are refused by the server through
 * LOCKED_SCREENS): server-rendered, tabs that are links, each form's fields with Required or
 * Optional, the protections, and on Join the consent version the form stores. Axe clean and
 * no sideways scroll on both tabs at 320, 390 and 1280 px (the editor drawn: its bilingual
 * pairs and Move buttons are tightest at 320). Admin v2 E8: above the as-built list, the forms
 * config's editor (the AdminForms island) draws a row per field (`data-edit-field`), with the
 * switches for an optional field only, and the captcha is a switch that is off and disabled.
 * Nothing is saved here: the public forms other suites read stay as built.
 */

test.skip(!staffEnv(), SKIP_REASON);
test.use({ storageState: authFile('developer'), contextOptions: { reducedMotion: 'reduce' } });

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function check(page: Page, where: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.help}`),
    where,
  ).toEqual([]);
  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over, `${where}: sideways scroll`).toBeLessThanOrEqual(0);
}

test('the inquiry form and the Join form, as the code decides them', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const res = await page.goto('/admin/forms');
  expect(res?.status()).toBe(200);
  const required = (key: string) => page.locator(`li[data-field="${key}"] .badge`);
  await expect(required('name')).toHaveText('Required');
  await expect(required('company')).toHaveText('Optional');
  // Every variant's fields: the phone is the services pages' alone, and says so.
  await expect(required('phone')).toHaveText('Optional');
  await expect(page.locator('li[data-field="phone"]')).toContainText('Only on the services pages');
  const captcha = page.getByRole('switch', { name: 'Captcha' });
  await expect(captcha).toBeDisabled();
  await expect(captcha).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#frm-captcha-state')).toHaveText('Not set up.');
  // The editor (E8): an optional field has its two switches, a field the site needs has none.
  const row = (key: string) => page.locator(`li[data-edit-field="${key}"]`);
  await expect(row('phone')).toContainText('Asked on the services pages');
  await expect(row('phone').getByRole('checkbox', { name: 'Shown on the form' })).toBeChecked();
  await expect(row('phone').getByRole('checkbox', { name: 'Required' })).not.toBeChecked();
  await expect(row('name').getByRole('checkbox')).toHaveCount(0);
  await expect(row('name').getByRole('button', { name: 'Move up' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save the inquiry form' })).toBeVisible();
  await expect(page.getByText(/^Rate limits: up to 10 an hour/)).toBeVisible();
  await check(page, 'inquiry');

  await page.getByRole('link', { name: 'Join form' }).click();
  await expect(page).toHaveURL(/\/admin\/forms\?tab=join$/);
  await expect(required('portfolio')).toHaveText('Required');
  await expect(required('linkedin')).toHaveText('Optional');
  await expect(page.locator('.frm-version')).toHaveText(RECRUITMENT_POLICY_VERSION);
  // The editor's consent card: with the lines as built, the form posts the notice's date.
  await expect(page.locator('.frm-next-version')).toHaveText(RECRUITMENT_POLICY_VERSION);
  await expect(row('cv').getByRole('checkbox', { name: 'Required' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save the Join form' })).toBeVisible();
  // Opening applications is Admin's switch: Developer reads the state, with no link to it.
  await expect(page.getByText(/^Applications are (open|closed)$/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Change it in General' })).toHaveCount(0);
  await check(page, 'join');
});

for (const width of [320, 390, 1280]) {
  test(`both tabs clean at ${width}px, with the editor drawn`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ['/admin/forms', '/admin/forms?tab=join']) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(200);
      // Both forms ask the name: its editor row is the island, hydrated.
      await expect(page.locator('li[data-edit-field="name"]')).toBeVisible();
      await check(page, `${path} at ${width}px`);
    }
  });
}
