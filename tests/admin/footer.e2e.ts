import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { discardDrafts, publishOwn, savedPattern, systemClient } from './releaseSteps';
import { SKIP_REASON, authFile, staffEnv } from './staff';

// The Footer screen (Admin v2 E6), end to end through the real Worker, session and database:
// Admin saves the footer's basics through the screen (a copyright template, the dark style,
// the mailbox hidden, the social icons shown), the sketch following the form before the save;
// adds a column, puts two links of this run's own in it through each link's Column choice,
// and the database refuses a fifth column (a 422 through the navigation API, the screen's
// button off at four). The public pages render all of it server-side in both languages (the
// column a <nav> named by its heading, the template filled in, Arabic-Indic digits in Arabic,
// data-style="dark", no mailbox, the icons, the legal links whatever is saved), and axe finds
// nothing in the dark footer. Content Creator sees the columns and not the basics (whose API
// refuses it); Developer the basics and not the columns (whose API refuses it).
//
// Everything is put back: the links and columns this run made are removed (the links first:
// parent_id cascades) and the footer's four settings return to what they were.
//
// Its own project (playwright.config.ts `footer`), after `header`: it changes the footer every
// public spec reads, served-html's bytes included.
//
// Both modes (Admin v2 R14b). With releases on the links, the column and the basics are pending
// changes (the screen says "Saved as an unpublished change"; the column count and the fifth
// column's 422 count the pending headings, assertNavWritable); the extra columns are thrown away
// as pending creates; one publish of this run's own identity and footer rows comes before the
// public footer is read. The clean-up throws this run's unclaimed pending changes away first,
// then removes what went live, as the system.

test.skip(!staffEnv(), SKIP_REASON);
test.describe.configure({ mode: 'serial' });

const PROFILE = '/api/admin/site-profile';
const NAV = '/api/admin/navigation';
const SCREEN = '/admin/appearance/footer';
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const RUN = Date.now().toString(36);

type Row = Record<string, unknown> & { version: number };
type Bilingual = { en: string; ar: string };

const COLUMN: Bilingual = { en: `Studio ${RUN}`, ar: `الاستوديو ${RUN}` };
const LINKS: readonly (Bilingual & { href: string })[] = [
  { en: `Our story ${RUN}`, ar: `قصتنا ${RUN}`, href: '/about' },
  { en: `Say hello ${RUN}`, ar: `قل مرحبا ${RUN}`, href: '/contact' },
];
const TEMPLATE: Bilingual = {
  en: '{brand}, {year}. Made in {place}.',
  ar: '{brand}، {year}. صُنع في {place}.',
};
const FOOTER_KEYS = [
  'footer_copyright',
  'footer_style',
  'footer_show_email',
  'footer_show_social',
] as const;

async function csrf(page: Page): Promise<string> {
  if (!page.url().includes('/admin')) await page.goto('/admin', { waitUntil: 'networkidle' });
  const token = await page.locator('meta[name="csrf-token"]').getAttribute('content');
  expect(token, 'the admin layout carries a CSRF token').toBeTruthy();
  return token!;
}

async function readProfile(page: Page): Promise<Row> {
  const res = await page.request.get(PROFILE);
  expect(res.status(), `GET ${PROFILE}`).toBe(200);
  return ((await res.json()) as { data: Row }).data;
}

/** A footer row made through the navigation API as the signed-in role; its id. */
async function create(page: Page, data: Record<string, unknown>): Promise<string> {
  const res = await page.request.post(NAV, {
    headers: { 'x-csrf-token': await csrf(page), origin: new URL(page.url()).origin },
    data,
  });
  expect([200, 201], await res.text()).toContain(res.status());
  const id = ((await res.json()) as { data: { id?: unknown } }).data.id;
  expect(typeof id, 'the new row has an id').toBe('string');
  return id as string;
}

/** The <footer> of a public page, as served. */
async function footerHtml(page: Page, path: string): Promise<string> {
  const res = await page.request.get(path);
  expect(res.status(), path).toBe(200);
  const html = await res.text();
  const footer = /<footer\b[^>]*class="site-footer"[\s\S]*?<\/footer>/.exec(html)?.[0];
  expect(footer, `${path} has the site footer`).toBeTruthy();
  return footer!;
}

/** The Arabic footer writes the year in Arabic-Indic digits (src/lib/i18n arabicIndic). */
const arabicDigits = (n: number) => String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]!);

let tenant: string | null = null;
let saved: Record<string, unknown> | null = null;
/** This run's links (in a column once the third test has run). */
const made: string[] = [];
/** This run's columns. */
const columns: string[] = [];

test.afterAll(async () => {
  if (!staffEnv() || !tenant) return;
  // Releases on: this run's own unclaimed pending changes first (the system's to clean).
  await discardDrafts([
    { entityType: 'nav_item', entityIds: [...made, ...columns] },
    { entityType: 'site_profile' },
  ]);
  const db = systemClient();
  // The links first, then the columns: a column's removal takes its links with it
  // (parent_id on delete cascade), and these are all this run's own.
  if (made.length) await db.from('navigation').delete().eq('tenant_id', tenant).in('id', made);
  if (columns.length) {
    await db.from('navigation').delete().eq('tenant_id', tenant).in('id', columns);
  }
  if (saved) await db.from('site_profile').update(saved).eq('tenant_id', tenant);
});

test.describe('as admin', () => {
  test.use({ storageState: authFile('admin'), contextOptions: { reducedMotion: 'reduce' } });

  test('the screen: the basics, the columns and the locked legal links; zero axe violations', async ({
    page,
  }) => {
    await page.goto('/admin', { waitUntil: 'networkidle' });
    const before = await readProfile(page);
    tenant = String(before['tenant_id']);
    saved = Object.fromEntries(FOOTER_KEYS.map((key) => [key, before[key] ?? null]));
    // Two links of this run's own, in no column yet.
    for (const link of LINKS) {
      made.push(
        await create(page, {
          location: 'footer',
          label: { en: link.en, ar: link.ar },
          href: link.href,
        }),
      );
    }

    await page.goto(SCREEN, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 1, name: 'Footer' })).toBeVisible();
    for (const name of ['Basics', 'Preview', 'Columns', 'Legal links']) {
      await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
    }
    // The legal links: shown locked, whatever is saved (PDPL).
    const legal = page.locator('.ftr-legal li');
    await expect(legal).toHaveCount(3);
    for (const name of ['Privacy', 'Terms', 'Cookies']) {
      await expect(legal.filter({ hasText: name })).toContainText('Always shown');
    }
    // Each of this run's links has its Column choice, set to no column.
    for (const link of LINKS) {
      await expect(page.getByRole('combobox', { name: `Column for ${link.en}` })).toHaveValue('');
    }
    const axe = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual(
      [],
    );
  });

  test('the basics save through the identity; the sketch follows the form first', async ({
    page,
  }) => {
    await page.goto(SCREEN, { waitUntil: 'networkidle' });
    const form = page.locator('form', { has: page.locator('#f-footerStyle') });
    await form
      .getByRole('group', { name: 'Editing language' })
      .getByRole('radio', { name: 'Both' })
      .check();
    await page.locator('#f-footerCopyright-en').fill(TEMPLATE.en);
    await page.locator('#f-footerCopyright-ar').fill(TEMPLATE.ar);
    await page.locator('#f-footerStyle').selectOption('dark');
    const email = page.locator('#f-footerShowEmail');
    const social = page.locator('#f-footerShowSocial');
    // Assert the starting state before toggling, so a click cannot pass by luck.
    await expect(email).toHaveAttribute('aria-checked', 'true');
    await expect(social).toHaveAttribute('aria-checked', 'false');
    await email.click();
    await social.click();
    await expect(email).toHaveAttribute('aria-checked', 'false');
    await expect(social).toHaveAttribute('aria-checked', 'true');

    // The sketch, before the save: dark, the template, no mailbox, the icons.
    const stage = page.locator('.ftr-pv__stage');
    await expect(stage).toHaveAttribute('data-style', 'dark');
    await expect(page.locator('.ftr-pv__copy')).toContainText('. Made in ');
    await expect(page.locator('.ftr-pv__mail')).toHaveCount(0);
    expect(await page.locator('.ftr-pv__icons i').count()).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Save the footer' }).click();
    // "Saved at 14:05", or with releases on "Saved as an unpublished change at 14:05".
    await expect(
      page.getByRole('status').filter({ hasText: savedPattern() }).first(),
    ).toBeVisible();
    expect(await readProfile(page)).toMatchObject({
      footer_copyright: TEMPLATE,
      footer_style: 'dark',
      footer_show_email: false,
      footer_show_social: true,
    });
  });

  test('a column: added, two links put in it, and no fifth (422; the button off)', async ({
    page,
  }) => {
    await page.goto(SCREEN, { waitUntil: 'networkidle' });
    const card = page.locator('section.card', {
      has: page.getByRole('heading', { level: 2, name: 'Columns', exact: true }),
    });
    const before = Number(/(\d) of 4 columns/.exec(await card.innerText())?.[1]);
    expect(before, 'the card counts the columns').toBeLessThanOrEqual(3);

    await card.getByLabel('Title (English)').fill(COLUMN.en);
    await card.getByLabel('Title (Arabic)').fill(COLUMN.ar);
    await card.getByRole('button', { name: 'Add a column', exact: true }).click();
    const column = card.locator('.ftr-cols__col', { hasText: COLUMN.en });
    await expect(column).toHaveCount(1);
    await expect(card).toContainText(`${before + 1} of 4 columns`);

    for (const link of LINKS) {
      await card
        .getByRole('combobox', { name: `Column for ${link.en}` })
        .selectOption({ label: COLUMN.en });
      await expect(column.locator('.ftr-cols__link', { hasText: link.en })).toHaveCount(1);
    }

    // The column's id, from the API, for the clean-up and the order below.
    const list = await page.request.get(`${NAV}?location=footer&limit=100`);
    expect(list.status()).toBe(200);
    const rows = ((await list.json()) as { data: { rows: Record<string, unknown>[] } }).data.rows;
    const heading = rows.find(
      (r) => r['is_heading'] === true && (r['label'] as Bilingual).en === COLUMN.en,
    );
    expect(heading, 'the new column is a heading row').toBeTruthy();
    columns.push(String(heading!['id']));
    for (const id of made) {
      expect(rows.find((r) => r['id'] === id)?.['parent_id'], id).toBe(heading!['id']);
    }
    // The order inside the column: Move up on the second link swaps them.
    await card.getByRole('button', { name: `Move ${LINKS[1]!.en} up` }).click();
    await expect(column.locator('.ftr-cols__link').first()).toContainText(LINKS[1]!.en);

    // Up to four: fill the rest through the API, then the fifth is refused.
    for (let n = before + 1; n < 4; n += 1) {
      columns.push(
        await create(page, {
          location: 'footer',
          label: { en: `Extra ${n} ${RUN}`, ar: `إضافي ${n} ${RUN}` },
          isHeading: true,
        }),
      );
    }
    const fifth = await page.request.post(NAV, {
      headers: { 'x-csrf-token': await csrf(page), origin: new URL(page.url()).origin },
      data: { location: 'footer', label: { en: 'Fifth', ar: 'خامس' }, isHeading: true },
    });
    expect(fifth.status(), await fifth.text()).toBe(422);
    const refusal = (await fifth.json()) as Record<string, unknown>;
    expect(refusal).toMatchObject({ ok: false, error: 'validation', field: 'isHeading' });
    expect(String(refusal['detail'])).toContain('already has 4 columns');
    await page.goto(SCREEN, { waitUntil: 'networkidle' });
    await expect(card).toContainText('4 of 4 columns');
    await expect(card.getByRole('button', { name: 'Add a column', exact: true })).toBeDisabled();
    // The extra columns go again (they hold no link, so nothing goes with them). With releases
    // on they are pending creates: thrown away as the system, never published.
    const extras = columns.slice(1);
    if (extras.length) {
      await discardDrafts([{ entityType: 'nav_item', entityIds: extras }]);
      const { error } = await systemClient()
        .from('navigation')
        .delete()
        .eq('tenant_id', tenant!)
        .in('id', extras);
      expect(error).toBeNull();
      columns.splice(1);
    }
  });

  test('the public footer renders it server-side, in both languages', async ({ page }) => {
    // Releases on: this run's own identity change, links and column go live together.
    await publishOwn(
      page,
      [
        { entityType: 'site_profile' },
        { entityType: 'nav_item', entityIds: [...made, ...columns] },
      ],
      4,
    );
    const profile = await readProfile(page);
    const brand = profile['brand_name'] as Bilingual;
    const place = profile['location'] as Bilingual;
    const year = new Date().getFullYear();

    for (const [path, lang] of [
      ['/about', 'en'],
      ['/ar/about', 'ar'],
    ] as const) {
      const footer = await footerHtml(page, path);
      const open = /<footer\b[^>]*>/.exec(footer)![0];
      expect(open, path).toContain('data-style="dark"');
      expect(open, path).not.toMatch(/\sstyle=/);
      // The template, filled in.
      const yearText = lang === 'ar' ? arabicDigits(year) : String(year);
      const line = TEMPLATE[lang]
        .replace('{brand}', brand[lang])
        .replace('{year}', yearText)
        .replace('{place}', place[lang]);
      expect(footer, path).toContain(`<p class="site-footer__copy">${line}</p>`);
      // No mailbox; the icons.
      expect(footer, path).not.toContain('site-footer__mail');
      expect(footer, path).toContain('class="site-footer__social"');
      // The column: a <nav> named by its heading, its links in the order set, localized.
      const col = new RegExp(
        `<nav class="site-footer__col" aria-labelledby="(site-footer-col-\\d)">\\s*<h2 class="site-footer__heading" id="\\1">${COLUMN[lang]}</h2>([\\s\\S]*?)</nav>`,
      ).exec(footer);
      expect(col, `${path}: the column`).not.toBeNull();
      const prefix = lang === 'ar' ? '/ar' : '';
      const hrefs = [...col![2]!.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [
        m[1],
        m[2],
      ]);
      expect(hrefs, path).toEqual([
        [`${prefix}${LINKS[1]!.href}`, LINKS[1]![lang]],
        [`${prefix}${LINKS[0]!.href}`, LINKS[0]![lang]],
      ]);
      // The legal links, whatever is saved.
      for (const legal of ['/privacy', '/terms', '/cookie-policy']) {
        expect(footer, `${path} ${legal}`).toContain(`href="${prefix}${legal}"`);
      }
    }
  });

  test('the dark footer passes axe in both languages', async ({ page }) => {
    for (const path of ['/about', '/ar/about']) {
      await page.goto(path);
      const footer = page.locator('footer.site-footer');
      await expect(footer).toHaveAttribute('data-style', 'dark');
      await footer.scrollIntoViewIfNeeded();
      const axe = await new AxeBuilder({ page })
        .include('footer.site-footer')
        .withTags(WCAG)
        .analyze();
      expect(
        axe.violations.map((v) => `${path} ${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`),
      ).toEqual([]);
    }
  });
});

test.describe('as content creator', () => {
  test.use({ storageState: authFile('content_creator') });

  test('sees the columns and not the basics, whose API refuses it', async ({ page }) => {
    await page.goto(SCREEN, { waitUntil: 'networkidle' });
    await expect(
      page.getByRole('heading', { level: 2, name: 'Columns', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Legal links' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Basics', exact: true })).toHaveCount(
      0,
    );
    expect((await page.request.get(PROFILE)).status()).toBe(403);
  });
});

test.describe('as developer', () => {
  test.use({ storageState: authFile('developer') });

  test('sees the basics and not the columns, whose API refuses it', async ({ page }) => {
    await page.goto(SCREEN, { waitUntil: 'networkidle' });
    await expect(
      page.getByRole('heading', { level: 2, name: 'Basics', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Legal links' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Columns', exact: true })).toHaveCount(
      0,
    );
    expect((await page.request.get(`${NAV}?location=footer`)).status()).toBe(403);
  });
});
