import { randomBytes } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { expectCleanAtWidths } from './collectionLayout';
import { SKIP_REASON, authFile, staffEnv } from './staff';

/*
 * The FAQ screen end to end (Admin v2 U7), signed in, against this job's local Supabase:
 * /admin/faq (the AdminCollection island) and what the Contact page shows for it.
 *
 *   as content_creator  add a question in both languages (a draft: not on /contact, not in
 *                       its FAQPage); publish it (on /contact and /ar/contact, its question
 *                       among the FAQPage names, the visible list still equal to the
 *                       JSON-LD set); move it up with the keyboard and with its arrow (the
 *                       public order follows); duplicate it (a draft copy right after it,
 *                       not public); an answer with a line break is refused on the field and
 *                       nothing is saved; no Delete and no Archived for this role; the list,
 *                       the add drawer and the edit drawer with zero axe WCAG 2.2 A/AA
 *                       violations and no sideways scroll at 320, 390 and 1280 px.
 *   as admin            archive the question, then delete it and its copy.
 *
 * The questions are this run's own (a random marker), added at the END of the list and
 * moved up one place at most, so the Contact suite's first question and its "at least ten"
 * stay true while this runs beside it; the service role removes whatever a failed run left.
 * Not here: "an empty FAQ hides the band and the FAQPage" (emptying the shared database
 * would race the Contact suite): tests/render/sections.spec.ts and tests/lib/contactPage.spec.ts.
 */

test.skip(!staffEnv(), SKIP_REASON);
test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ mode: 'serial' });

const MARK = `E2E ${randomBytes(4).toString('hex')}`;
const Q = { en: `${MARK}: can you answer this?`, ar: `${MARK}: هل تجيبون على هذا؟` };
const A = { en: 'Yes. One paragraph, answer first.', ar: 'نعم. فقرة واحدة، والإجابة أولًا.' };

function service() {
  const env = staffEnv()!;
  return createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

test.afterAll(async () => {
  if (!staffEnv()) return;
  // Whatever this run left (a failed step, the copy): only rows carrying its marker.
  await service().from('faq_items').delete().like('question->>en', `${MARK}%`);
});

async function openScreen(page: Page) {
  await page.goto('/admin/faq', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  await expect(page.locator('ul.coll__list')).toBeVisible();
}

/** The questions /contact shows, and the names its FAQPage lists. */
async function publicFaq(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'load' });
  const visible = await page.$$eval('.faq-item__t', (els) =>
    els.map((e) => (e.textContent ?? '').trim()),
  );
  const ld = await page.$$eval('script[type="application/ld+json"]', (els) =>
    els.map((e) => JSON.parse(e.textContent ?? 'null') as { '@type'?: string }),
  );
  const block = ld.find((n) => n?.['@type'] === 'FAQPage') as
    { mainEntity: { name: string }[] } | undefined;
  return { visible, asked: block ? block.mainEntity.map((q) => q.name) : [] };
}

/** A list row's action: focus, then Enter (hover arms a pointer press only after 0.2s). */
async function pressRowAction(button: Locator): Promise<void> {
  await button.focus();
  await button.press('Enter');
}

const row = (page: Page, text: string) => page.locator('ul.coll__list > li', { hasText: text });
const dialog = (page: Page) => page.getByRole('dialog');

async function showBoth(page: Page) {
  await dialog(page)
    .getByRole('group', { name: 'Editing language' })
    .getByRole('radio', { name: 'Both' })
    .check();
}

async function openRow(page: Page, text: string) {
  // The first such row: after Duplicate the original and its copy share the question.
  await row(page, text).first().locator('a.li__t').click();
  await expect(dialog(page).getByRole('heading', { name: 'Edit question' })).toBeVisible();
  await expect(dialog(page).locator('#f-question-en')).toHaveValue(/\S/);
}

test.describe('as content_creator', () => {
  test.use({ storageState: authFile('content_creator') });

  test('a new question is a draft: not on the Contact page, not in its FAQPage', async ({
    page,
  }) => {
    await openScreen(page);
    await page.locator('a[data-collection-add]').click();
    await expect(page).toHaveURL(/\/admin\/faq\/new$/);
    await expect(dialog(page).getByRole('heading', { name: 'New question' })).toBeVisible();
    await expect(dialog(page)).toContainText(
      'While no question is published, the Contact page shows no FAQ.',
    );
    await showBoth(page);
    await dialog(page).locator('#f-question-en').fill(Q.en);
    await dialog(page).locator('#f-question-ar').fill(Q.ar);
    await dialog(page).locator('#f-answer-en').fill(A.en);
    await dialog(page).locator('#f-answer-ar').fill(A.ar);
    await dialog(page).getByRole('button', { name: 'Add', exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/admin\/faq$/);
    // Last in the list (a new item's place is after the rest), focused, marked Draft.
    await expect(page.locator('ul.coll__list > li').last()).toContainText(Q.en);
    await expect(row(page, Q.en).locator('a.li__t')).toBeFocused();
    await expect(row(page, Q.en)).toContainText('Draft');

    for (const path of ['/contact', '/ar/contact']) {
      const faq = await publicFaq(page, path);
      expect(faq.visible.join('\n'), path).not.toContain(MARK);
      expect(faq.asked.join('\n'), path).not.toContain(MARK);
    }
  });

  test('the list and both drawers at 320, 390 and 1280 px: zero axe, no sideways scroll', async ({
    page,
  }) => {
    await openScreen(page);
    await expectCleanAtWidths(page, 'the FAQ list');

    await page.locator('a[data-collection-add]').click();
    await expect(dialog(page).getByRole('heading', { name: 'New question' })).toBeVisible();
    await showBoth(page);
    await expectCleanAtWidths(page, 'the add drawer');

    await openScreen(page);
    await openRow(page, Q.en);
    await showBoth(page);
    await expectCleanAtWidths(page, 'the edit drawer');
  });

  test('published, it is on both Contact pages and in both FAQPages, word for word', async ({
    page,
  }) => {
    await openScreen(page);
    await openRow(page, Q.en);
    // This role may not archive (content.archiveDelete): the option is not offered.
    await expect(dialog(page).locator('#f-status option[value="archived"]')).toHaveCount(0);
    await expect(dialog(page).getByRole('button', { name: 'Delete' })).toHaveCount(0);
    await dialog(page).locator('#f-status').selectOption('published');
    await dialog(page).getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(row(page, Q.en)).not.toContainText('Draft');

    for (const [path, words] of [
      ['/contact', Q.en],
      ['/ar/contact', Q.ar],
    ] as const) {
      const faq = await publicFaq(page, path);
      expect(faq.visible, path).toContain(words);
      expect(faq.asked, path).toContain(words);
      expect([...faq.asked].sort(), path).toEqual([...faq.visible].sort());
    }
  });

  test('moved up with the keyboard, then with its arrow: the public order follows', async ({
    page,
  }) => {
    const place = async () => (await publicFaq(page, '/contact')).visible.indexOf(Q.en);
    const before = await place();
    expect(before).toBeGreaterThan(1);

    await openScreen(page);
    const handle = page.getByRole('button', { name: `Reorder ${Q.en}` });
    await handle.focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Space');
    await expect(page.locator('.toast', { hasText: 'Order updated.' }).first()).toBeVisible();
    expect(await place()).toBe(before - 1);

    await openScreen(page);
    await page.getByRole('button', { name: `Move ${Q.en} down` }).click();
    await expect(page.locator('.toast', { hasText: 'Order updated.' }).first()).toBeVisible();
    expect(await place()).toBe(before);
  });

  test('Duplicate: a draft copy right after the original, not on the Contact page', async ({
    page,
  }) => {
    await openScreen(page);
    // A row action takes no pointer press until hover has armed it (0.2s, kept under reduced
    // motion); focus arms it at once, so it is reached as a keyboard user does.
    await pressRowAction(
      row(page, Q.en)
        .first()
        .getByRole('button', { name: `Duplicate ${Q.en}` }),
    );
    await expect(page.locator('.toast', { hasText: 'Copied as a draft.' }).first()).toBeVisible();
    await expect(row(page, Q.en)).toHaveCount(2);
    const rows = page.locator('ul.coll__list > li');
    const texts = await rows.allTextContents();
    const first = texts.findIndex((t) => t.includes(Q.en));
    expect(texts[first + 1]).toContain(Q.en);
    expect(texts[first + 1]).toContain('Draft');

    const faq = await publicFaq(page, '/contact');
    expect(faq.visible.filter((q) => q === Q.en)).toHaveLength(1);
    expect(faq.asked.filter((q) => q === Q.en)).toHaveLength(1);
  });

  test('an answer with a line break is refused on its field; nothing is saved', async ({
    page,
  }) => {
    await openScreen(page);
    const count = await page.locator('ul.coll__list > li').count();
    await page.locator('a[data-collection-add]').click();
    await showBoth(page);
    await dialog(page).locator('#f-question-en').fill(`${MARK} two lines?`);
    await dialog(page).locator('#f-question-ar').fill(`${MARK} سطران؟`);
    await dialog(page).locator('#f-answer-en').fill('Line one.\nLine two.');
    await dialog(page).locator('#f-answer-ar').fill('سطر.');
    await dialog(page).getByRole('button', { name: 'Add', exact: true }).click();
    await expect(
      dialog(page)
        .getByText(/no line breaks/)
        .first(),
    ).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Close' }).click();
    await openScreen(page);
    await expect(page.locator('ul.coll__list > li')).toHaveCount(count);
  });
});

test.describe('as admin', () => {
  test.use({ storageState: authFile('admin') });

  test('archives the question, then deletes it and its copy', async ({ page }) => {
    await openScreen(page);
    await openRow(page, Q.en);
    await dialog(page).locator('#f-status').selectOption('archived');
    await dialog(page).getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(row(page, Q.en).first()).toContainText('Archived');
    expect((await publicFaq(page, '/contact')).visible).not.toContain(Q.en);

    await openScreen(page);
    while ((await row(page, Q.en).count()) > 0) {
      await openRow(page, Q.en);
      await dialog(page).getByRole('button', { name: 'Delete' }).click();
      await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
      await expect(page.locator('.toast', { hasText: 'Deleted.' }).first()).toBeVisible();
      await openScreen(page);
    }
    await expect(row(page, Q.en)).toHaveCount(0);
  });
});
