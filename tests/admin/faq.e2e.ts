import { randomBytes } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { DELETE_WORDS } from '@/components/admin/screens/collection/collections';
import { expectCleanAtWidths } from './collectionLayout';
import {
  discardDrafts,
  discardDraftsLike,
  publishOwn,
  reorderedIds,
  systemClient,
} from './releaseSteps';
import { SKIP_REASON, authFile, releasesOn, staffEnv } from './staff';

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
 *
 * Both modes (Admin v2 R14d). With releases on every save is a pending change: the new question
 * is a pending create (still a draft, "New · not live yet"); the drawer's status is the
 * "Visible on the site" switch (and "Archived", which only an Admin is offered); each step that
 * reads the Contact page first publishes exactly this run's own changes (`publishOwn`: the
 * question, and the rows a move named, read from the reorder's own request); Delete throws the
 * pending copy away and stages the original's removal (DELETE_WORDS), which is then published.
 * The clean-up throws this run's unclaimed pending changes away as the system before it removes
 * the rows. A move touches the question and the row just above it (the end of the list), never
 * the first rows other specs open.
 */

test.skip(!staffEnv(), SKIP_REASON);
test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ mode: 'serial' });

const MARK = `E2E ${randomBytes(4).toString('hex')}`;
const Q = { en: `${MARK}: can you answer this?`, ar: `${MARK}: هل تجيبون على هذا؟` };
const A = { en: 'Yes. One paragraph, answer first.', ar: 'نعم. فقرة واحدة، والإجابة أولًا.' };

/** Rows a move of this run named that are not its own (the row above it), for the clean-up. */
const touched = new Set<string>();

test.afterAll(async () => {
  if (!staffEnv()) return;
  // Releases on: this run's unclaimed pending changes first (its creates by the marker, the
  // moved rows by id), as the system.
  await discardDraftsLike('faq_item', 'payload->question->>en', `${MARK}%`);
  await discardDrafts([{ entityType: 'faq_item', entityIds: [...touched] }]);
  // Whatever this run left (a failed step, the copy): only rows carrying its marker.
  await systemClient().from('faq_items').delete().like('question->>en', `${MARK}%`);
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

/** A row's id, from its title link (/admin/faq/<id>). */
async function idOf(page: Page, text: string, nth = 0): Promise<string> {
  const href = await row(page, text).nth(nth).locator('a.li__t').getAttribute('href');
  const id = href?.split('/').pop();
  expect(id, `the row's link names its id (${href})`).toBeTruthy();
  return id!;
}

/** Releases on: publishes this run's own questions, by id; releases off: nothing to do. */
async function publishQuestions(page: Page, ids: readonly string[]): Promise<void> {
  await publishOwn(page, [{ entityType: 'faq_item', entityIds: ids }]);
}

/** A move through the list; with releases on, the rows its reorder named are published. */
async function move(page: Page, act: () => Promise<void>): Promise<void> {
  const sent = page.waitForRequest(
    (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/admin/faq/reorder',
  );
  await act();
  const ids = reorderedIds((await sent).postData());
  await expect(page.locator('.toast', { hasText: 'Order updated.' }).first()).toBeVisible();
  const own = await idOf(page, Q.en);
  for (const id of ids) if (id !== own) touched.add(id);
  await publishQuestions(page, ids);
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
    const id = await idOf(page, Q.en);
    await openRow(page, Q.en);
    await expect(dialog(page).getByRole('button', { name: 'Delete' })).toHaveCount(0);
    if (releasesOn()) {
      // The release form: a switch for the status, and no Archived for this role.
      await expect(dialog(page).locator('select#f-status')).toHaveCount(0);
      await expect(dialog(page).getByRole('switch', { name: 'Archived' })).toHaveCount(0);
      const visible = dialog(page).getByRole('switch', { name: 'Visible on the site' });
      await expect(visible).toHaveAttribute('aria-checked', 'false');
      await visible.click();
      await expect(visible).toHaveAttribute('aria-checked', 'true');
    } else {
      // This role may not archive (content.archiveDelete): the option is not offered.
      await expect(dialog(page).locator('#f-status option[value="archived"]')).toHaveCount(0);
      await dialog(page).locator('#f-status').selectOption('published');
    }
    await dialog(page).getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(row(page, Q.en)).not.toContainText('Draft');
    // Releases on: the pending question goes live with this run's own publish.
    await publishQuestions(page, [id]);

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
    await move(page, async () => {
      const handle = page.getByRole('button', { name: `Reorder ${Q.en}` });
      await handle.focus();
      await page.keyboard.press('Space');
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('Space');
    });
    expect(await place()).toBe(before - 1);

    await openScreen(page);
    await move(page, () => page.getByRole('button', { name: `Move ${Q.en} down` }).click());
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
    const original = await idOf(page, Q.en);
    await openRow(page, Q.en);
    if (releasesOn()) {
      await dialog(page).getByRole('switch', { name: 'Archived' }).click();
    } else {
      await dialog(page).locator('#f-status').selectOption('archived');
    }
    await dialog(page).getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(row(page, Q.en).first()).toContainText('Archived');
    await publishQuestions(page, [original]);
    expect((await publicFaq(page, '/contact')).visible).not.toContain(Q.en);

    await openScreen(page);
    if (!releasesOn()) {
      while ((await row(page, Q.en).count()) > 0) {
        await openRow(page, Q.en);
        await dialog(page).getByRole('button', { name: 'Delete' }).click();
        await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
        await expect(
          page.locator('.toast', { hasText: DELETE_WORDS.deleted }).first(),
        ).toBeVisible();
        await openScreen(page);
      }
    } else {
      // The pending copy is thrown away (it was never on the site); the original's removal is
      // a pending change of its own until it is published.
      await expect(row(page, Q.en)).toHaveCount(2);
      const copy = await idOf(page, Q.en, 1);
      for (const [id, words] of [
        [copy, DELETE_WORDS.discarded],
        [original, DELETE_WORDS.removal],
      ] as const) {
        await page.locator(`ul.coll__list a.li__t[href="/admin/faq/${id}"]`).click();
        await expect(dialog(page).getByRole('heading', { name: 'Edit question' })).toBeVisible();
        await expect(dialog(page).locator('#f-question-en')).toHaveValue(/\S/);
        await dialog(page).getByRole('button', { name: 'Delete' }).click();
        await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
        await expect(page.locator('.toast', { hasText: words }).first()).toBeVisible();
        await openScreen(page);
      }
      await expect(row(page, Q.en)).toHaveCount(1);
      await publishQuestions(page, [original]);
      await openScreen(page);
    }
    await expect(row(page, Q.en)).toHaveCount(0);
  });
});
