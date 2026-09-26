import { expect, test, type Page } from '@playwright/test';

/*
 * Sitewide chrome (UI v2): the header and footer every public page shares.
 *
 * Runs against the seeded local database, whose navigation and public identity are the
 * same lists as the code fallbacks (tests/seed/seeds.spec.ts proves that), so these
 * assertions hold whether the menu came from the CMS or the fallback.
 */

// The home intro is a timed plate over everything; these tests are about the chrome, so
// they start as a returning visitor (the intro cuts on the session flag).
async function skipIntro(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      sessionStorage.setItem('bs_intro', '1');
    } catch {
      /* storage blocked: the intro still ends on its own */
    }
  });
}

// Room to scroll regardless of how much content the database holds — the behaviour
// under test is the header's, not the page's. (CSSOM write from the test, not markup.)
async function makeScrollable(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.body.style.minHeight = '4000px';
  });
}

const HEADER = {
  en: {
    root: '/',
    items: [
      ['Home', '/'],
      ['About', '/about'],
      ['Our Work', '/portfolio'],
      ['Services', '/#services'],
      ['Contact us', '/contact'],
    ],
  },
  ar: {
    root: '/ar',
    items: [
      ['الرئيسية', '/ar'],
      ['من نحن', '/ar/about'],
      ['أعمالنا', '/ar/portfolio'],
      ['الخدمات', '/ar#services'],
      ['تواصل معنا', '/ar/contact'],
    ],
  },
} as const;

test.beforeEach(async ({ page }) => {
  await skipIntro(page);
});

for (const locale of ['en', 'ar'] as const) {
  const { root, items } = HEADER[locale];

  test(`header menu is the UI v2 list, localized — ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 800 });
    await page.goto(root);
    const links = page.locator('.site-nav__list > li > a');
    await expect(links).toHaveCount(items.length);
    for (const [i, [label, href]] of items.entries()) {
      await expect(links.nth(i)).toHaveText(label);
      // Fragments stay attached to the localized path: /ar#services, never /ar/#services.
      await expect(links.nth(i)).toHaveAttribute('href', href);
    }
  });

  test(`only the page you are on is current — ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 800 });
    // /ar used to prefix-match every Arabic URL, so Home was "current" on all of them.
    await page.goto(locale === 'ar' ? '/ar/about' : '/about');
    const current = page.locator('.site-nav__list a[aria-current="page"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveText(items[1][0]);

    await page.goto(root);
    const onHome = page.locator('.site-nav__list a[aria-current="page"]');
    await expect(onHome).toHaveCount(1);
    await expect(onHome).toHaveText(items[0][0]); // not Services (/#services is an anchor)
  });

  test(`at <=900px only the key link stays in the bar — ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 823 });
    await page.goto(locale === 'ar' ? '/ar/services' : '/services');
    const key = page.locator('.site-header__key');
    await expect(key).toBeVisible();
    await expect(key).toHaveText(items[4][0]);
    await expect(page.locator('.site-nav__panel')).toBeHidden();

    // The full list is one tap away, in the native disclosure.
    await page.locator('.site-nav__toggle').click();
    await expect(page.locator('.site-nav__panel')).toBeVisible();
    await expect(page.locator('.site-nav__list > li > a')).toHaveCount(items.length);
  });

  test(`following a same-page link closes the small-screen menu — ${locale}`, async ({ page }) => {
    // /#services on home is an in-page jump: nothing reloads, so an open <details> would
    // stay pinned over the section the visitor asked for.
    await page.setViewportSize({ width: 412, height: 823 });
    await page.goto(root);
    await page.locator('.site-nav__toggle').click();
    await page.locator('.site-nav__panel a', { hasText: items[3][0] }).click();
    await expect(page).toHaveURL(/#services$/);
    await expect(page.locator('details.site-nav')).not.toHaveAttribute('open', /.*/);
    await expect(page.locator('.site-nav__panel')).toBeHidden();
  });

  test(`wide screens show the list, not the key-link copy — ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 800 });
    await page.goto(root);
    await expect(page.locator('.site-header__key')).toBeHidden();
    await expect(page.locator('.site-nav__toggle')).toBeHidden();
    await expect(page.locator('.site-nav__list')).toBeVisible();
  });
}

test('the solid header hides on the way down and returns on the way up', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 800 });
  await page.goto('/services');
  await makeScrollable(page);
  const header = page.locator('.site-header');
  await expect(header).toHaveClass(/site-header--solid/);

  await page.mouse.wheel(0, 900);
  await expect(header).toHaveClass(/is-hidden/);
  await page.mouse.wheel(0, -200);
  await expect(header).not.toHaveClass(/is-hidden/);
});

test('the home header turns solid once the hero is behind it', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 800 });
  await page.goto('/');
  const header = page.locator('.site-header');
  await expect(header).toHaveClass(/site-header--overlay/);
  await expect(header).not.toHaveClass(/is-solid/);
  // The backdrop is a ::before layer that fades by opacity alone (compositor-only).
  const before = () => header.evaluate((el) => getComputedStyle(el, '::before').opacity);
  expect(await before()).toBe('0');

  await page.evaluate(() => window.scrollTo(0, window.innerHeight * 1.5));
  await expect(header).toHaveClass(/is-solid/);
  await expect.poll(before).toBe('1');
});

test('a hidden header comes back for keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 800 });
  await page.goto('/services');
  await makeScrollable(page);
  await page.mouse.wheel(0, 900);
  const header = page.locator('.site-header');
  await expect(header).toHaveClass(/is-hidden/);
  await page.locator('.site-header__lang').focus();
  await expect.poll(() => header.evaluate((el) => getComputedStyle(el).transform)).toBe('none');
});

// ── Footer ────────────────────────────────────────────────────────────────────────
test('the footer bar names the studio, its city and its mailbox — en', async ({ page }) => {
  await page.goto('/');
  const year = new Date().getFullYear();
  await expect(page.locator('.site-footer__copy')).toHaveText(
    `© ${year} Braiin Statiion. Jeddah, Saudi Arabia`,
  );
  const mail = page.locator('.site-footer__mail');
  await expect(mail).toHaveAttribute('href', 'mailto:hello@braiinstatiion.com');
  await expect(mail).toHaveText('hello@braiinstatiion.com');
});

test('the Arabic footer writes the year in Arabic-Indic digits — ar', async ({ page }) => {
  await page.goto('/ar');
  const year = new Intl.NumberFormat('ar-SA-u-nu-arab', { useGrouping: false }).format(
    new Date().getFullYear(),
  );
  await expect(page.locator('.site-footer__copy')).toHaveText(
    `© ${year} بريّن ستيشن. جدة، المملكة العربية السعودية`,
  );
  // The address is isolated LTR so it does not re-order inside RTL text.
  await expect(page.locator('.site-footer__mail')).toHaveAttribute('dir', 'ltr');
});

test('the footer keeps the section links and the PDPL legal links', async ({ page }) => {
  await page.goto('/ar');
  const lists = page.locator('.site-footer__list');
  await expect(lists.nth(0).locator('a')).toHaveText([
    'الخدمات',
    'أعمالنا',
    'المعرفة',
    'من نحن',
    'تواصل معنا',
  ]);
  await expect(lists.nth(1).locator('a')).toHaveText(['الخصوصية', 'الشروط', 'ملفات الارتباط']);
  await expect(lists.nth(1).locator('a').first()).toHaveAttribute('href', '/ar/privacy');
});
