import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { RELEASES_OFF_ONLY, SKIP_REASON, authFile, releasesOn, staffEnv } from './staff';

// The Header screen (Admin v2 E5), end to end through the real Worker, session and database:
// Admin saves the header's options through the screen (a large logo, the links beside the
// language switch, a button) and the public pages render them server-side, in both
// languages, the large logo in the bar's first frame; a see-through bar with too light a tint
// is refused; each option is then saved through the API and measured on the public pages in
// both languages (the logo's positions and sizes with and without the button: one row,
// --bs-header-h tall; the phone menu's button and full-screen menu; not sticky; never hidden;
// the blur; the tint); Content Creator sees the menu card and not the options (and the options
// API refuses it); Developer the options and not the menu card. Everything is put back: the row
// is removed, which is the header as built, byte for byte (tests/render/siteChrome.spec.ts).
//
// Its own project (playwright.config.ts `header`), after `general`: it changes the header every
// public spec reads, served-html's bytes and the layout-shift measurements included.

test.skip(!staffEnv(), SKIP_REASON);
// The release-mode rehearsal (Admin v2 R14-prep): written for releases off.
test.skip(releasesOn(), RELEASES_OFF_ONLY);
test.describe.configure({ mode: 'serial' });

const API = '/api/admin/site-appearance';
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

type Row = Record<string, unknown> & { version: number };

function service() {
  const env = staffEnv()!;
  return createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function csrf(page: Page): Promise<string> {
  if (!page.url().includes('/admin')) await page.goto('/admin', { waitUntil: 'networkidle' });
  const token = await page.locator('meta[name="csrf-token"]').getAttribute('content');
  expect(token, 'the admin layout carries a CSRF token').toBeTruthy();
  return token!;
}

async function read(page: Page): Promise<Row> {
  const res = await page.request.get(API);
  expect(res.status(), `GET ${API}`).toBe(200);
  return ((await res.json()) as { data: Row }).data;
}

/** The opening <header> tag of a public page, as served. */
async function headerTag(page: Page, path: string): Promise<string> {
  const html = await (await page.request.get(path)).text();
  return /<header\b[^>]*class="site-header[^"]*"[^>]*>/.exec(html)?.[0] ?? '';
}

/** Every option at the header as built, with the button's words and link ready to show. */
const AS_BUILT = {
  logoPosition: 'start',
  logoSize: 'm',
  menuAlign: 'center',
  sticky: true,
  hideOnScroll: true,
  solidAfterHero: true,
  tint: 'none',
  blur: 'soft',
  mobileMenu: 'drawer',
  ctaShow: false,
  ctaLabel: { en: 'Start a project', ar: 'ابدأ مشروعك' },
  ctaHref: '/contact#inquiry',
} as const;

/** Saves the header's options through the screen's API, on top of the stored version. */
async function save(page: Page, values: Record<string, unknown>): Promise<void> {
  const token = await csrf(page);
  const row = await read(page);
  const res = await page.request.patch(API, {
    headers: { 'x-csrf-token': token, origin: new URL(page.url()).origin },
    data: { ...values, version: row.version },
  });
  expect(res.status(), await res.text()).toBe(200);
}

/** The logo's width per preset at a viewport width (global.css; LOGO_SIZES). */
function logoWidth(size: 's' | 'm' | 'l', width: number): number {
  const presets: Record<'s' | 'm' | 'l', readonly [number, number, number]> = {
    s: [80, 8, 108],
    m: [96, 10, 132],
    l: [96, 12, 160],
  };
  const [min, vw, max] = presets[size];
  return Math.min(max, Math.max(min, (width * vw) / 100));
}

/** The bar's box against --bs-header-h, where the logo sits, and any sideways overflow. */
async function barBox(page: Page) {
  return page.evaluate(() => {
    // A probe sized by the variable (a CSSOM write from the test, not markup).
    const probe = document.createElement('div');
    probe.style.height = 'var(--bs-header-h)';
    document.body.appendChild(probe);
    const headerH = probe.getBoundingClientRect().height;
    probe.remove();
    const bar = document.querySelector('.site-header__bar')!.getBoundingClientRect();
    const brand = document.querySelector('.site-header__brand')!.getBoundingClientRect();
    const logo = document.querySelector('.site-header__brand img')!.getBoundingClientRect();
    const rtl = document.documentElement.dir === 'rtl';
    return {
      bar: bar.height,
      headerH,
      logo: logo.width,
      barMid: (bar.left + bar.right) / 2,
      brandMid: (brand.left + brand.right) / 2,
      brandFromStart: rtl ? bar.right - brand.right : brand.left - bar.left,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

// Room to scroll whatever the page holds: the behaviour under test is the header's (a CSSOM
// write from the test, as tests/e2e/header-footer.e2e.ts does).
async function makeScrollable(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.body.style.minHeight = '6000px';
  });
}

let tenant: string | null = null;

test.afterAll(async () => {
  if (!staffEnv()) return;
  // No row is the header as built: remove what this run saved (the service role, outside any
  // release; releases are off for this spec).
  if (tenant) await service().from('site_appearance').delete().eq('tenant_id', tenant);
});

test.describe('as admin', () => {
  test.use({ storageState: authFile('admin'), contextOptions: { reducedMotion: 'reduce' } });

  test('the screen saves the options; zero axe violations', async ({ page }) => {
    await page.goto('/admin/appearance/header', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 1, name: 'Header' })).toBeVisible();
    for (const name of ['Menu items', 'Layout', 'Behaviour', 'Button', 'Preview']) {
      await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
    }
    // The defaults: no button, so the sketches show none.
    await expect(page.locator('.hdr-pv__cta')).toHaveCount(0);
    const axe = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual(
      [],
    );

    await page.locator('#f-logoSize').selectOption('l');
    await page.locator('#f-menuAlign').selectOption('end');
    await page.locator('#f-ctaShow').click();
    await expect(page.locator('#f-ctaShow')).toHaveAttribute('aria-checked', 'true');
    await page
      .locator('form', { has: page.locator('#f-ctaHref') })
      .getByRole('group', { name: 'Editing language' })
      .getByRole('radio', { name: 'Both' })
      .check();
    await page.locator('#f-ctaLabel-en').fill('Start a project');
    await page.locator('#f-ctaLabel-ar').fill('ابدأ مشروعك');
    await page.locator('#f-ctaHref').fill('/contact#inquiry');
    // The sketches follow the form before it is saved.
    await expect(page.locator('.hdr-pv__bar[data-logo="l"]')).toHaveCount(2);
    await expect(page.locator('.hdr-pv__cta').first()).toHaveText('Start a project');

    await page.getByRole('button', { name: 'Save the header' }).click();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: /Saved at \d\d:\d\d/ })
        .first(),
    ).toBeVisible();
    const row = await read(page);
    tenant = String(row['tenant_id']);
    expect(row).toMatchObject({
      header_logo_size: 'l',
      header_menu_align: 'end',
      header_cta_show: true,
      header_cta_label: { en: 'Start a project', ar: 'ابدأ مشروعك' },
      header_cta_href: '/contact#inquiry',
      header_tint: 'none',
    });
  });

  test('the public pages render the saved header, server-side, in both languages', async ({
    page,
  }) => {
    const en = await headerTag(page, '/about');
    expect(en).toContain('data-logo="l"');
    expect(en).toContain('data-align="end"');
    expect(en).not.toContain('style=');
    const html = await (await page.request.get('/about')).text();
    expect(html).toMatch(
      /<a class="site-header__cta" href="\/contact#inquiry"[^>]*>Start a project<\/a>/,
    );
    expect(html).toContain('sizes="clamp(96px, 12vw, 160px)"');
    // The language switch is still there (O-13), beside the button.
    expect(html).toMatch(/<div class="site-header__end">[\s\S]*?class="site-header__lang"/);
    const ar = await (await page.request.get('/ar/about')).text();
    expect(ar).toMatch(
      /<a class="site-header__cta" href="\/ar\/contact#inquiry"[^>]*>ابدأ مشروعك<\/a>/,
    );

    // The large preset reaches the root, so the bar and every offset built on it follow.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/about');
    const logoW = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bs-logo-w').trim(),
    );
    expect(logoW).toBe('clamp(96px, 12vw, 160px)');
    await expect(page.locator('a.site-header__cta')).toBeVisible();
  });

  test('the large logo is in the first frame: the bar never grows after it paints', async ({
    page,
  }) => {
    // ui.md AV-28 "layout-shift with logo presets". The preset is CSS on the root
    // (`:root:has(.site-header[data-logo])`, global.css), so the bar is drawn at its large
    // height in the very first frame and nothing under it moves. About wears the solid bar,
    // which is in flow (position: sticky): a preset that arrived late would push the whole page
    // down. The bar and the logo are read in the first animation frame that has them (frames
    // run only once the render-blocking stylesheet is in), then again after load with the
    // fonts in, and must be equal. A shift count would not do: All projects' bar is the
    // fixed overlay, which moves nothing, and a late preset on an in-flow bar still measured
    // under layout-shift.e2e's 0.02 allowance.
    await page.addInitScript(() => {
      const w = window as Window & { __bsFirstBar?: { bar: number; logo: number } };
      const read = (): void => {
        const bar = document.querySelector('.site-header__bar');
        const logo = document.querySelector('.site-header__brand img');
        if (!bar || !logo) {
          requestAnimationFrame(read);
          return;
        }
        w.__bsFirstBar = {
          bar: bar.getBoundingClientRect().height,
          logo: logo.getBoundingClientRect().width,
        };
      };
      requestAnimationFrame(read);
    });
    await page.setViewportSize({ width: 1350, height: 940 });
    await page.goto('/about', { waitUntil: 'load' });
    const header = page.locator('header.site-header');
    await expect(header).toHaveAttribute('data-logo', 'l');
    await expect(header).toHaveClass(/site-header--solid/);
    await page.evaluate(() => document.fonts.ready);
    const seen = await page.evaluate(
      () =>
        new Promise<{
          first: { bar: number; logo: number } | null;
          bar: number;
          logo: number;
          headerH: number;
        }>((resolve) => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const w = window as Window & { __bsFirstBar?: { bar: number; logo: number } };
              const probe = document.createElement('div');
              probe.style.height = 'var(--bs-header-h)';
              document.body.appendChild(probe);
              const headerH = probe.getBoundingClientRect().height;
              probe.remove();
              resolve({
                first: w.__bsFirstBar ?? null,
                bar: document.querySelector('.site-header__bar')!.getBoundingClientRect().height,
                logo: document.querySelector('.site-header__brand img')!.getBoundingClientRect()
                  .width,
                headerH,
              });
            }),
          );
        }),
    );
    expect(seen.first, 'the first frame was read').not.toBeNull();
    // L at 1350 px: clamp(96px, 12vw, 160px) = 160 px, from the first frame on.
    expect(seen.first!.logo, JSON.stringify(seen)).toBeCloseTo(160, 0);
    expect(seen.logo, JSON.stringify(seen)).toBeCloseTo(160, 0);
    expect(Math.abs(seen.first!.bar - seen.bar), JSON.stringify(seen)).toBeLessThan(0.5);
    // ...and the bar is the height every offset reads (--bs-header-h).
    expect(Math.abs(seen.bar - seen.headerH), JSON.stringify(seen)).toBeLessThan(0.5);
  });

  test('a sticky bar that stays see-through after the hero needs the darkest tint (422)', async ({
    page,
  }) => {
    const row = await read(page);
    const refused = await page.request.patch(API, {
      headers: { 'x-csrf-token': await csrf(page), origin: new URL(page.url()).origin },
      data: { sticky: true, solidAfterHero: false, tint: 'medium', version: row.version },
    });
    expect(refused.status(), await refused.text()).toBe(422);
    const taken = await page.request.patch(API, {
      headers: { 'x-csrf-token': await csrf(page), origin: new URL(page.url()).origin },
      data: { sticky: true, solidAfterHero: false, tint: 'dark', version: row.version },
    });
    expect(taken.status(), await taken.text()).toBe(200);
    const tag = await headerTag(page, '/about');
    expect(tag).toContain('data-solid="off"');
    expect(tag).toContain('data-tint="dark"');
  });

  // ── Each option rendered (ui.md AV-28 "header-footer.e2e for each variant") ──────────────
  // Saved through the API (the screen's own route), then measured on the public pages in
  // both languages. About wears the solid bar (in flow), Contact the overlay over a hero.

  for (const logoPosition of ['start', 'center'] as const) {
    for (const logoSize of ['s', 'm', 'l'] as const) {
      test(`logo ${logoPosition}, ${logoSize}: one row, --bs-header-h tall, the logo at its preset, with and without the button`, async ({
        page,
      }) => {
        test.slow();
        for (const ctaShow of [false, true]) {
          await save(page, { ...AS_BUILT, logoPosition, logoSize, ctaShow });
          for (const path of ['/about', '/ar/about']) {
            await page.setViewportSize({ width: 1280, height: 800 });
            await page.goto(path);
            const header = page.locator('header.site-header');
            // The saved options are what this page renders (not an earlier save's).
            if (logoPosition === 'center') {
              await expect(header).toHaveAttribute('data-logo-pos', 'center');
            } else {
              await expect(header).not.toHaveAttribute('data-logo-pos', /.*/);
            }
            await expect(page.locator('a.site-header__cta')).toHaveCount(ctaShow ? 1 : 0);
            await page.evaluate(() => document.fonts.ready);
            for (const width of [901, 1024, 1280, 1440]) {
              await page.setViewportSize({ width, height: 800 });
              const box = await barBox(page);
              const where = `${path} @${width} ${logoPosition} ${logoSize} button=${ctaShow}: ${JSON.stringify(box)}`;
              // One row: exactly the height every offset built on --bs-header-h reads.
              expect(Math.abs(box.bar - box.headerH), where).toBeLessThan(1);
              expect(box.overflow, where).toBeLessThanOrEqual(0);
              expect(Math.abs(box.logo - logoWidth(logoSize, width)), where).toBeLessThan(0.6);
              if (logoPosition === 'center' && width >= 1280) {
                // Centred in the bar...
                expect(Math.abs(box.brandMid - box.barMid), where).toBeLessThan(1.5);
              } else {
                // ...or at the start (the left in English, the right in Arabic).
                expect(box.brandFromStart, where).toBeLessThan(80);
              }
            }
          }
        }
      });
    }
  }

  test('the phone menu: the button is the pill, and the full-screen menu fills the screen', async ({
    page,
  }) => {
    test.slow();
    for (const mobileMenu of ['drawer', 'full'] as const) {
      await save(page, { ...AS_BUILT, logoSize: 'l', mobileMenu, ctaShow: true });
      for (const path of ['/about', '/ar/about']) {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(path);
        const header = page.locator('header.site-header');
        if (mobileMenu === 'full') {
          await expect(header).toHaveAttribute('data-mobile', 'full');
        } else {
          await expect(header).not.toHaveAttribute('data-mobile', /.*/);
        }
        await page.locator('.site-nav__toggle').click();
        const pill = page.locator('.site-nav__panel a.site-nav__cta');
        await expect(pill).toBeVisible();
        const look = await pill.evaluate((el) => {
          const cs = getComputedStyle(el);
          return {
            padding: cs.padding,
            fontSize: cs.fontSize,
            underline: getComputedStyle(el, '::after').content,
          };
        });
        // The bar's pill (7px 15px, 12px), never a menu link's padding, size or underline.
        expect(look, `${path} ${mobileMenu}`).toEqual({
          padding: '7px 15px',
          fontSize: '12px',
          underline: 'none',
        });
        const panel = await page.evaluate(() => {
          const r = document.querySelector('.site-nav__panel')!.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, viewport: window.innerHeight };
        });
        if (mobileMenu === 'full') {
          // Under the bar, down to the bottom of the screen.
          expect(Math.abs(panel.bottom - panel.viewport), JSON.stringify(panel)).toBeLessThan(1);
        } else {
          expect(panel.bottom, JSON.stringify(panel)).toBeLessThan(panel.viewport);
        }
        const box = await barBox(page);
        expect(Math.abs(box.bar - box.headerH), `${path} ${JSON.stringify(box)}`).toBeLessThan(1);
        expect(box.overflow, `${path} ${JSON.stringify(box)}`).toBeLessThanOrEqual(0);
      }
    }
  });

  test('not sticky: the bar scrolls away with the page and the script leaves it alone', async ({
    page,
  }) => {
    await save(page, { ...AS_BUILT, sticky: false });
    for (const [path, position] of [
      ['/about', 'relative'],
      ['/ar/about', 'relative'],
      ['/contact', 'absolute'],
      ['/ar/contact', 'absolute'],
    ] as const) {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(path);
      const header = page.locator('header.site-header');
      await expect(header).toHaveAttribute('data-sticky', 'off');
      expect(await header.evaluate((el) => getComputedStyle(el).position), path).toBe(position);
      await makeScrollable(page);
      await page.evaluate(() => window.scrollTo(0, 2000));
      await expect
        .poll(() => header.evaluate((el) => el.getBoundingClientRect().bottom), { message: path })
        .toBeLessThanOrEqual(0);
      await expect(header).not.toHaveClass(/is-solid|is-hidden/);
    }
  });

  test('sticky, never hidden: the bar turns solid past the hero and stays on screen', async ({
    page,
  }) => {
    await save(page, { ...AS_BUILT, hideOnScroll: false });
    for (const path of ['/contact', '/ar/contact']) {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(path);
      const header = page.locator('header.site-header');
      await expect(header).toHaveAttribute('data-hide', 'off');
      await makeScrollable(page);
      await page.mouse.move(640, 400);
      await page.mouse.wheel(0, 1600);
      // The scroll script ran (the bar turned solid past the hero)...
      await expect(header).toHaveClass(/is-solid/);
      await page.mouse.wheel(0, 600);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(2000);
      // ...and, scrolling on down, did not hide it.
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      await expect(header).not.toHaveClass(/is-hidden/);
      expect(await header.evaluate((el) => el.getBoundingClientRect().top), path).toBe(0);
    }
  });

  test('the blur behind the solid bar: none, soft (as built) and strong', async ({ page }) => {
    for (const [blur, filter] of [
      ['none', 'none'],
      ['soft', 'blur(14px)'],
      ['strong', 'blur(24px)'],
    ] as const) {
      await save(page, { ...AS_BUILT, hideOnScroll: false, blur });
      for (const path of ['/contact', '/ar/contact']) {
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(path);
        const header = page.locator('header.site-header');
        await makeScrollable(page);
        await page.evaluate(() => window.scrollTo(0, 2000));
        await expect(header).toHaveClass(/is-solid/);
        await expect
          .poll(() => header.evaluate((el) => getComputedStyle(el, '::before').backdropFilter), {
            message: `${path} blur ${blur}`,
          })
          .toBe(filter);
      }
    }
  });

  test('the tint over the hero: its layer, its shade, and what it does past the hero', async ({
    page,
  }) => {
    const layer = () =>
      page.locator('header.site-header').evaluate((el) => {
        const cs = getComputedStyle(el, '::after');
        return { content: cs.content, background: cs.backgroundColor, opacity: cs.opacity };
      });
    for (const [tint, shade] of [
      ['light', 'rgba(0, 0, 0, 0.25)'],
      ['medium', 'rgba(0, 0, 0, 0.45)'],
    ] as const) {
      await save(page, { ...AS_BUILT, hideOnScroll: false, tint });
      for (const path of ['/contact', '/ar/contact']) {
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(path);
        await expect(page.locator('header.site-header')).toHaveAttribute('data-tint', tint);
        // Over the hero: the tint's own layer, at its shade.
        await expect
          .poll(layer, { message: `${path} ${tint}` })
          .toEqual({ content: '""', background: shade, opacity: '1' });
        // Past the hero the solid bar takes over and the tint fades out.
        await makeScrollable(page);
        await page.evaluate(() => window.scrollTo(0, 2000));
        await expect(page.locator('header.site-header')).toHaveClass(/is-solid/);
        await expect.poll(async () => (await layer()).opacity).toBe('0');
      }
    }
    // A bar that stays see-through keeps the darkest tint over the page below the hero.
    await save(page, { ...AS_BUILT, hideOnScroll: false, solidAfterHero: false, tint: 'dark' });
    for (const path of ['/contact', '/ar/contact']) {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(path);
      await makeScrollable(page);
      await page.evaluate(() => window.scrollTo(0, 2000));
      await expect
        .poll(layer, { message: path })
        .toEqual({ content: '""', background: 'rgba(0, 0, 0, 0.62)', opacity: '1' });
      await expect(page.locator('header.site-header')).not.toHaveClass(/is-solid/);
    }
  });
});

test.describe('as content creator', () => {
  test.use({ storageState: authFile('content_creator') });

  test('sees the menu card and not the options, which the API refuses', async ({ page }) => {
    await page.goto('/admin/appearance/header', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 2, name: 'Menu items' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Layout', exact: true })).toHaveCount(
      0,
    );
    expect((await page.request.get(API)).status()).toBe(403);
  });
});

test.describe('as developer', () => {
  test.use({ storageState: authFile('developer') });

  test('sees the options and not the menu card', async ({ page }) => {
    await page.goto('/admin/appearance/header', { waitUntil: 'networkidle' });
    await expect(
      page.getByRole('heading', { level: 2, name: 'Layout', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Menu items' })).toHaveCount(0);
  });
});
