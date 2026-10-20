import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { SKIP_REASON, authFile, staffEnv } from './staff';

/*
 * The Style-Finder screens on the field kit (Admin v2 U8a), signed in, through the real Worker:
 *   questions  as Admin: a question made with two options through the repeater (no JSON box),
 *              reopened with both options in both languages; the list's Input column says
 *              "Single choice", not the stored key; Move down reorders two questions;
 *   notes      each screen says the quiz is not live;
 *   roles      Content Creator sees Questions and Styles and no Results & logic tab (the
 *              server refuses that screen: tests/admin/refusals.e2e.ts);
 *   results    Admin saves Results & logic (the version moves), clean at 320, 390 and 1280.
 * The rows are NOT deleted afterwards: the sweep opens the first row of these lists
 * (UNSEEDED_LISTS) and a row removed between its list and its open would 404 there; the CI
 * database is per run. Their slugs are this run's own.
 */

test.skip(!staffEnv(), SKIP_REASON);

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const RUN = Date.now().toString(36);
const NOT_LIVE = 'The Style-Finder is not on the site yet.';

async function ready(page: Page) {
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  await page.waitForLoadState('networkidle');
}

async function axeClean(page: Page, where: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    where,
  ).toEqual([]);
}

async function noSidewaysScroll(page: Page, where: string) {
  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over, `${where}: sideways scroll`).toBeLessThanOrEqual(0);
}

/** Makes a question through the form: two options, both languages, at a sort order. */
async function createQuestion(page: Page, slug: string, prompt: string, sortOrder: number) {
  await page.goto('/admin/ai-questions/new');
  await ready(page);
  await expect(page.getByText(NOT_LIVE)).toHaveCount(0); // the note is the list's
  await page.getByRole('radio', { name: 'Both' }).check();
  await page.locator('#f-slug').fill(slug);
  await page.locator('#f-prompt-en').fill(prompt);
  await page.locator('#f-prompt-ar').fill('ما الأسلوب الذي تفضله؟');
  await page.locator('#f-inputType').selectOption('single');
  for (const [index, [value, en, ar]] of [
    ['warm', 'Warm', 'دافئ'],
    ['cool', 'Cool', 'بارد'],
  ].entries()) {
    await page.getByRole('button', { name: 'Add options' }).click();
    await page.locator(`#f-options-${index}-value`).fill(value!);
    await page.locator(`#f-options-${index}-label-en`).fill(en!);
    await page.locator(`#f-options-${index}-label-ar`).fill(ar!);
  }
  await page.locator('#f-sortOrder').fill(String(sortOrder));
  await page.getByRole('button', { name: 'Create question' }).click();
  await page.waitForURL(/\/admin\/ai-questions\/[0-9a-f-]{36}/);
  await ready(page);
}

test.describe('as Admin', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ storageState: authFile('admin'), contextOptions: { reducedMotion: 'reduce' } });

  test('a question’s options are a repeater, kept in both languages', async ({ page }) => {
    await createQuestion(page, `e2e-sf-${RUN}-a`, `Palette ${RUN} A`, 9001);
    await expect(page.locator('textarea.in--mono')).toHaveCount(0); // no JSON box for options
    await page.reload();
    await ready(page);
    await page.getByRole('radio', { name: 'Both' }).check();
    await expect(page.locator('#f-options-0-value')).toHaveValue('warm');
    await expect(page.locator('#f-options-1-value')).toHaveValue('cool');
    await expect(page.locator('#f-options-0-label-en')).toHaveValue('Warm');
    await expect(page.locator('#f-options-1-label-ar')).toHaveValue('بارد');
    await axeClean(page, 'question editor');
  });

  test('the list says the input type in words, and Move down reorders', async ({ page }) => {
    await createQuestion(page, `e2e-sf-${RUN}-b`, `Palette ${RUN} B`, 9002);
    await page.goto('/admin/ai-questions');
    await ready(page);
    await expect(page.getByText(NOT_LIVE)).toBeVisible();
    await page.getByRole('searchbox', { name: /^Search/ }).fill(`e2e-sf-${RUN}`);
    const rows = page.getByRole('table').getByRole('row');
    await expect(rows.filter({ hasText: `Palette ${RUN}` })).toHaveCount(2);
    const first = rows.filter({ hasText: `Palette ${RUN} A` });
    await expect(first).toContainText('Single choice');
    await expect(first).not.toContainText(/\bsingle\b/);
    const names = async () =>
      (await rows.filter({ hasText: `Palette ${RUN}` }).allTextContents()).map((t) =>
        t.includes(`Palette ${RUN} A`) ? 'A' : 'B',
      );
    expect(await names()).toEqual(['A', 'B']);
    const down = page.getByRole('button', { name: `Move Palette ${RUN} A down` });
    await down.focus();
    await page.keyboard.press('Enter');
    await expect.poll(names).toEqual(['B', 'A']);
  });

  test('Styles says the quiz is not live too', async ({ page }) => {
    await page.goto('/admin/ai-styles');
    await ready(page);
    await expect(page.getByText(NOT_LIVE)).toBeVisible();
  });

  for (const width of [320, 390, 1280]) {
    test(`Results & logic at ${width}px: clean, and a save moves the version`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/admin/ai-config');
      await ready(page);
      await expect(page.getByText('Nothing here is read yet.')).toBeVisible();
      await expect(page.getByText('today the limit is fixed at 60 an hour')).toBeVisible();
      await axeClean(page, `results ${width}`);
      await noSidewaysScroll(page, `results ${width}`);
      const version = async () =>
        (await page.locator('.form-actions .admin-sub').last().textContent()) ?? '';
      const was = await version();
      await page.locator('#f-model').fill(`e2e-model-${RUN}-${width}`);
      await page.getByRole('button', { name: /^Save style-finder results/ }).click();
      await expect(page.locator('.save-status')).toContainText(/Saved/);
      await expect.poll(version).not.toBe(was);
    });
  }
});

test.describe('as Content Creator', () => {
  test.use({
    storageState: authFile('content_creator'),
    contextOptions: { reducedMotion: 'reduce' },
  });

  test('Questions and Styles, no Results & logic tab, and the note', async ({ page }) => {
    await page.goto('/admin/ai-questions');
    await ready(page);
    const tabs = page.getByRole('navigation', { name: 'Style-Finder sections' });
    await expect(tabs.getByRole('link', { name: 'Questions' })).toBeVisible();
    await expect(tabs.getByRole('link', { name: 'Styles' })).toBeVisible();
    await expect(tabs.getByRole('link', { name: 'Results & logic' })).toHaveCount(0);
    await expect(page.getByText(NOT_LIVE)).toBeVisible();
    await axeClean(page, 'cc questions');
  });
});
