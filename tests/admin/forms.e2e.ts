import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { RECRUITMENT_POLICY_VERSION } from '@consent/recruitment';
import { SKIP_REASON, authFile, staffEnv } from './staff';

/*
 * The Forms overview (Admin v2 U11, /admin/forms), signed in as Developer (settings.general;
 * Admin is swept, Content Creator, SEO and Sales are refused by the server through
 * LOCKED_SCREENS): server-rendered, tabs that are links, each form's fields with Required or
 * Optional, the protections, and on Join the consent version the form stores. Axe clean and
 * no sideways scroll on both tabs at 390 px.
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
  await expect(page.getByText('Captcha: Not set up.')).toBeVisible();
  await expect(page.getByText(/^Rate limits: up to 10 an hour/)).toBeVisible();
  await check(page, 'inquiry');

  await page.getByRole('link', { name: 'Join form' }).click();
  await expect(page).toHaveURL(/\/admin\/forms\?tab=join$/);
  await expect(required('portfolio')).toHaveText('Required');
  await expect(required('linkedin')).toHaveText('Optional');
  await expect(page.locator('.frm-version')).toHaveText(RECRUITMENT_POLICY_VERSION);
  // Opening applications is Admin's switch: Developer reads the state, with no link to it.
  await expect(page.getByText(/^Applications are (open|closed)$/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Change it in General' })).toHaveCount(0);
  await check(page, 'join');
});
