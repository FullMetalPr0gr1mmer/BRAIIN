import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { discardDrafts, publishOwn, savedPattern, systemClient, withDraft } from './releaseSteps';
import { SKIP_REASON, authFile, releasesOn, staffEnv } from './staff';

// The Loading screen (Admin v2 E7), end to end through the real Worker, session and database:
// Admin saves a look through the screen (logo on black, the bar, a tagline in both languages,
// an 800 ms hold and a 300 ms fade) after the preview follows the form and plays; the home page
// renders it server-side in both languages; its choreography runs on the buckets in the order
// docs/hero-intro.md pins (the plate holds 800 ms, the bar fills over the hold, nothing of the
// hero shows before the plate is gone); the opaque plate stays click-through and the consent
// banner sits above it, so a consent click lands; the logo is still recorded for LCP; reduced
// motion shows no plate whatever the buckets say; a light plate draws the logo black and the
// tagline dark; an off-step hold is refused. Content Creator gets the on/off switch only (and
// the look's API refuses it): off, the home page has no plate in either language; on, it is
// back. Developer gets the look and not the switch. Everything is put back: the row is
// removed (the intro as built, byte for byte: tests/render/introOptions.spec.ts) and the home
// hero's content restored.
//
// Its own project (playwright.config.ts `loading`), after `footer`: it changes the home page
// every public spec reads (hero-intro.e2e.ts pins the intro as built).
//
// Both modes (Admin v2 R14b). With releases on the look (site_appearance) and the switch (the
// home hero's page section) are pending changes: each save names its pending change, the
// screen says "Saved as an unpublished change", and this spec publishes its own change (the
// look, or the home hero) right after, before the home page is read (releaseSteps.ts). The
// clean-up throws this run's unclaimed pending changes away first, then puts the row and the
// hero back as the system.

test.skip(!staffEnv(), SKIP_REASON);
test.describe.configure({ mode: 'serial' });

const APPEARANCE = [{ entityType: 'site_appearance' }] as const;

const API = '/api/admin/site-appearance';
const SCREEN = '/admin/appearance/loading';
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const TAGLINE = { en: 'From the brain to the real world.', ar: 'من الفكرة إلى الواقع.' };

type Row = Record<string, unknown> & { version: number };

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

/**
 * Saves the look through the screen's API, on top of what is stored (with releases on, naming
 * the pending change, and then publishing this spec's own change when the save took); the
 * status.
 */
async function save(page: Page, values: Record<string, unknown>): Promise<number> {
  const token = await csrf(page);
  const row = await read(page);
  const res = await page.request.patch(API, {
    headers: { 'x-csrf-token': token, origin: new URL(page.url()).origin },
    data: withDraft(row, values),
  });
  if (res.status() === 200) await publishOwn(page, APPEARANCE, 0);
  return res.status();
}

/** The opening tag of the home page's plate, as served. */
async function plateTag(page: Page, path: string): Promise<string> {
  const html = await (await page.request.get(path)).text();
  return /<div class="intro"[^>]*>/.exec(html)?.[0] ?? '';
}

/** A fresh visitor (no session, no consent, no once-per-tab flag), motion allowed. */
async function visitor(browser: Browser, reducedMotion: 'reduce' | 'no-preference') {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion });
  return { ctx, page: await ctx.newPage() };
}

/** Freezes every finite document-timeline animation at T ms (hero-intro.e2e.ts's seek). */
async function seek(page: Page, t: number): Promise<void> {
  await page.evaluate((ms) => {
    for (const a of document.getAnimations()) {
      if (!(a.timeline instanceof DocumentTimeline)) continue;
      if (a.effect?.getComputedTiming().iterations === Infinity) continue;
      a.pause();
      a.currentTime = ms;
    }
  }, t);
}

/** Composited opacity of the first match (0 when it or an ancestor is not rendered). */
async function visibility(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return -1;
    let o = 1;
    for (let n: Element | null = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
      o *= parseFloat(cs.opacity);
    }
    return Number(o.toFixed(3));
  }, selector);
}

/** A leaf token of the choreography, in ms (as hero-intro.e2e.ts's timeline reads it). */
async function token(page: Page, name: string): Promise<number> {
  return page.evaluate((n) => {
    const v = getComputedStyle(document.body).getPropertyValue(n).trim();
    return v.endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000;
  }, name);
}

let tenant: string | null = null;
/** The home hero's content as this run found it, to put back. */
let heroBefore: { id: string; content: unknown } | null = null;

async function homeHero(): Promise<{ id: string; content: unknown } | null> {
  if (!tenant) return null;
  const db = systemClient();
  const { data: page } = await db
    .from('pages')
    .select('id')
    .eq('tenant_id', tenant)
    .eq('slug', 'home')
    .maybeSingle();
  if (!page) return null;
  const { data } = await db
    .from('page_sections')
    .select('id,content')
    .eq('page_id', (page as { id: string }).id)
    .eq('type', 'hero')
    .eq('visible', true)
    .order('sort_order', { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as { id: string; content: unknown } | null) ?? null;
}

test.beforeAll(async () => {
  // Releases on: no pending look of an earlier run under this one's saves.
  await discardDrafts(APPEARANCE);
});

test.afterAll(async () => {
  if (!staffEnv()) return;
  // Releases on: this run's own unclaimed pending changes first (the system's to clean).
  await discardDrafts([
    ...APPEARANCE,
    ...(heroBefore ? [{ entityType: 'page_section', entityIds: [heroBefore.id] }] : []),
  ]);
  // No row is the intro (and the header) as built: remove what this run saved, and put the
  // home hero's content back (the service role, which the release guard lets through: an
  // out-of-band system change, recorded as one).
  if (tenant) await systemClient().from('site_appearance').delete().eq('tenant_id', tenant);
  if (heroBefore) {
    await systemClient()
      .from('page_sections')
      .update({ content: heroBefore.content })
      .eq('id', heroBefore.id);
  }
});

test.describe('as admin', () => {
  test.use({ storageState: authFile('admin'), contextOptions: { reducedMotion: 'reduce' } });

  test('the screen saves the look; the preview follows the form; zero axe violations', async ({
    page,
  }) => {
    await page.goto(SCREEN, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 1, name: 'Loading screen' })).toBeVisible();
    for (const name of ['On the home page', 'Style', 'Timing', 'Preview', 'Always true']) {
      await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
    }
    // The seeded home hero has no `intro` key: the route's default, on.
    const toggle = page.getByRole('switch', { name: 'Show the loading screen' });
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    // The defaults: the video style, no bar, no tagline, the built-in timing.
    await expect(page.getByRole('radio', { name: 'Logo over the video' })).toBeChecked();
    const plate = page.locator('.ld-pv__plate');
    await expect(plate).toHaveCount(1);
    await expect(plate).toHaveAttribute('data-backdrop', 'video');
    await expect(plate).toHaveAttribute('data-hold', '1000');
    await expect(plate).toHaveAttribute('data-fade', '450');
    const axe = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual(
      [],
    );

    await page.getByRole('radio', { name: 'Logo on black' }).check();
    await page.locator('#f-bar').click();
    await expect(page.locator('#f-bar')).toHaveAttribute('aria-checked', 'true');
    await page
      .locator('form', { has: page.locator('#f-holdMs') })
      .getByRole('group', { name: 'Editing language' })
      .getByRole('radio', { name: 'Both' })
      .check();
    await page.locator('#f-tagline-en').fill(TAGLINE.en);
    await page.locator('#f-tagline-ar').fill(TAGLINE.ar);
    // The sliders move by their steps from the keyboard (a native input event, which React's
    // onChange sees; a scripted value set is swallowed by its value tracker): 1000 to 800 ms by
    // 100, 450 to 300 ms by 50.
    const hold = page.locator('#f-holdMs');
    await expect(hold).toHaveValue('1000');
    await hold.focus();
    for (let i = 0; i < 2; i += 1) await hold.press('ArrowLeft');
    await expect(hold).toHaveValue('800');
    const fade = page.locator('#f-fadeMs');
    await expect(fade).toHaveValue('450');
    await fade.focus();
    for (let i = 0; i < 3; i += 1) await fade.press('ArrowLeft');
    await expect(fade).toHaveValue('300');
    // The preview follows the form before it is saved, and plays on a press.
    await expect(plate).toHaveAttribute('data-backdrop', 'black');
    await expect(plate).toHaveAttribute('data-hold', '800');
    await expect(plate).toHaveAttribute('data-fade', '300');
    await expect(page.locator('.ld-pv__tag')).toHaveText(TAGLINE.en);
    await expect(page.locator('.ld-pv__bar')).toHaveCount(1);
    await expect(page.locator('.ld-pv__cap')).toContainText('The logo on black');
    await page.getByRole('button', { name: 'Play preview' }).click();
    await expect(page.locator('.ld-pv__plate[data-play]')).toHaveCount(1);

    await page.getByRole('button', { name: 'Save the loading screen' }).click();
    // "Saved at 14:05", or with releases on "Saved as an unpublished change at 14:05".
    await expect(
      page.getByRole('status').filter({ hasText: savedPattern() }).first(),
    ).toBeVisible();
    const row = await read(page);
    tenant = String(row['tenant_id']);
    expect(row).toMatchObject({
      intro_backdrop: 'black',
      intro_bar: true,
      intro_tagline: TAGLINE,
      intro_hold_ms: 800,
      intro_fade_ms: 300,
      // The header's options are untouched by this screen's save.
      header_logo_size: 'm',
      header_tint: 'none',
    });
    heroBefore = await homeHero();
    expect(heroBefore, 'the seeded home page has a visible hero').not.toBeNull();
    // Releases on: the screen saved a pending change; the home page needs it live.
    await publishOwn(page, APPEARANCE);
  });

  test('the home page renders the saved look, server-side, in both languages', async ({ page }) => {
    for (const path of ['/', '/ar']) {
      const tag = await plateTag(page, path);
      expect(tag, `${path} renders the plate`).not.toBe('');
      expect(tag).toBe(
        '<div class="intro" aria-hidden="true" data-backdrop="black" data-hold="800" data-fade="300">',
      );
    }
    const en = await (await page.request.get('/')).text();
    expect(en).toContain(
      `<div class="intro__below"><p class="intro__tag">${TAGLINE.en}</p><span class="intro__bar"><i></i></span></div>`,
    );
    const ar = await (await page.request.get('/ar')).text();
    expect(ar).toContain(`<p class="intro__tag">${TAGLINE.ar}</p>`);
    // No inline style, no new script: the buckets are global.css's.
    const plate = /<div class="intro"[\s\S]*?<section class="hero/.exec(en)?.[0] ?? '';
    expect(plate).not.toBe('');
    expect(plate).not.toContain('style=');
    // Only the home page has the plate.
    expect(await plateTag(page, '/about')).toBe('');
  });

  test('a hold or fade off its steps is refused (422), and nothing is written', async ({
    page,
  }) => {
    expect(await save(page, { holdMs: 750 })).toBe(422);
    expect(await save(page, { fadeMs: 700 })).toBe(422);
    expect(await save(page, { holdMs: 2000 })).toBe(422);
    expect(await read(page)).toMatchObject({ intro_hold_ms: 800, intro_fade_ms: 300 });
  });
});

test.describe('the saved look on the home page (a visitor)', () => {
  test('the timing follows the buckets and the order holds; the bar fills over the hold', async ({
    browser,
  }) => {
    const { ctx, page } = await visitor(browser, 'no-preference');
    await page.goto('/', { waitUntil: 'load' });
    // The buckets set the two inputs; everything else derives from them.
    expect(await token(page, '--bs-intro-hold')).toBe(800);
    expect(await token(page, '--bs-intro-fade')).toBe(300);
    const wait = 800 + 300;

    // Mid-hold: the plate is up, the logo and what hangs below it are in, the bar half full,
    // and nothing of the hero shows.
    await seek(page, 500);
    expect(await visibility(page, '.intro')).toBe(1);
    expect(await visibility(page, '.intro img')).toBeGreaterThan(0.95);
    expect(await visibility(page, '.intro__tag')).toBeGreaterThan(0.95);
    const scale = await page.evaluate(() => {
      const m = getComputedStyle(document.querySelector('.intro__bar i')!).transform;
      return m === 'none' ? 1 : new DOMMatrix(m).a;
    });
    // From the guard (.12 s) over the rest of the hold (.68 s): (500 - 120) / 680 ≈ .56.
    expect(scale).toBeGreaterThan(0.45);
    expect(scale).toBeLessThan(0.67);
    expect(await visibility(page, '.hero h1 .letter')).toBe(0);
    expect(await visibility(page, '.hero__cta')).toBe(0);

    // The plate is gone at hold + fade, before the first letter begins.
    await seek(page, wait + 1);
    expect(await visibility(page, '.intro')).toBe(0);
    await ctx.close();
  });

  test('an opaque plate takes no click, and the consent banner sits above it', async ({
    browser,
  }) => {
    const { ctx, page } = await visitor(browser, 'no-preference');
    await page.goto('/', { waitUntil: 'load' });
    await page.waitForTimeout(200); // the plate holds for 800 ms
    const css = await page.evaluate(() => {
      const plate = getComputedStyle(document.querySelector('.intro')!);
      const banner = getComputedStyle(document.querySelector('.consent-banner')!);
      return {
        pointer: plate.pointerEvents,
        ground: plate.backgroundColor,
        plateZ: plate.zIndex,
        bannerZ: banner.zIndex,
      };
    });
    expect(css).toEqual({
      pointer: 'none',
      ground: 'rgb(0, 0, 0)',
      plateZ: '90',
      bannerZ: '91',
    });
    // A raw click on Accept while the plate is up (hero-intro.e2e.ts's consent test): it is
    // recorded and the banner closes.
    const box = await page.locator('#consent-banner [data-consent="accept"]').boundingBox();
    expect(box, 'the consent banner shows on a first visit').not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.locator('#consent-banner')).toBeHidden();
    expect(await page.evaluate(() => document.cookie.includes('__Host-consent'))).toBe(true);
    await ctx.close();
  });

  test('the logo stays the LCP element with an opaque plate, a bar and a tagline', async ({
    browser,
  }) => {
    for (const route of ['/', '/ar']) {
      const { ctx, page } = await visitor(browser, 'no-preference');
      await page.addInitScript(() => {
        (window as unknown as { __lcp: unknown[] }).__lcp = [];
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            const el = (e as PerformanceEntry & { element?: Element }).element;
            (window as unknown as { __lcp: unknown[] }).__lcp.push({
              tag: el?.tagName ?? null,
              intro: !!el?.closest('.intro'),
            });
          }
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      });
      await page.goto(route, { waitUntil: 'load' });
      await page.waitForTimeout(3000);
      const lcp = await page.evaluate(
        () => (window as unknown as { __lcp: { tag: string | null; intro: boolean }[] }).__lcp,
      );
      expect(lcp.length, `${route}: no LCP candidate was recorded`).toBeGreaterThan(0);
      // As hero-intro.e2e.ts holds it for the intro as built: the logo is recorded (its box,
      // file and entrance from opacity .01 are unchanged by the look).
      expect(
        lcp.some((e) => e.tag === 'IMG' && e.intro),
        `${route}: the logo is recorded`,
      ).toBe(true);
      await ctx.close();
    }
  });

  test('reduced motion: no plate, whatever the buckets say', async ({ browser }) => {
    const { ctx, page } = await visitor(browser, 'reduce');
    await page.goto('/', { waitUntil: 'load' });
    expect(await visibility(page, '.intro')).toBe(0);
    expect(await token(page, '--bs-intro-hold')).toBe(0);
    expect(await token(page, '--bs-intro-fade')).toBe(0);
    expect(await visibility(page, '.hero h1 .letter')).toBe(1);
    await ctx.close();
  });
});

test.describe('a light plate (admin)', () => {
  test.use({ storageState: authFile('admin') });

  test('draws the logo black and the tagline dark', async ({ page, browser }) => {
    expect(await save(page, { backdrop: 'light' })).toBe(200);
    expect(await plateTag(page, '/')).toContain('data-backdrop="light"');
    const { ctx, page: home } = await visitor(browser, 'no-preference');
    await home.goto('/', { waitUntil: 'load' });
    await seek(home, 400);
    const look = await home.evaluate(() => ({
      ground: getComputedStyle(document.querySelector('.intro')!).backgroundColor,
      logo: getComputedStyle(document.querySelector('.intro img')!).filter,
      tagline: getComputedStyle(document.querySelector('.intro__tag')!).color,
    }));
    expect(look).toEqual({
      ground: 'rgb(255, 255, 255)',
      logo: 'brightness(0)',
      tagline: 'rgb(42, 47, 58)',
    });
    await ctx.close();
  });
});

test.describe('as content_creator', () => {
  test.use({ storageState: authFile('content_creator') });

  test('the switch only: off, the home page has no plate; on, it is back', async ({ page }) => {
    await page.goto(SCREEN, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 2, name: 'On the home page' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Style', exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole('button', { name: 'Save the loading screen' })).toHaveCount(0);
    // The look's API refuses it (theme.edit).
    expect((await page.request.get(API)).status()).toBe(403);

    const toggle = page.getByRole('switch', { name: 'Show the loading screen' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    // Releases on: the switch is the home hero's own change, published by this spec alone.
    const hero = await homeHero();
    expect(hero, 'the home page has a visible hero').not.toBeNull();
    const HERO = [{ entityType: 'page_section', entityIds: [hero!.id] }];
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(toggle).toBeEnabled();
    await publishOwn(page, HERO);
    for (const path of ['/', '/ar']) {
      const html = await (await page.request.get(path)).text();
      expect(html, `${path} still renders its hero`).toContain('<section class="hero');
      expect(html, `${path} has no plate`).not.toContain('class="intro"');
    }
    if (releasesOn()) {
      // The publish went out through the route, not this screen's own savebar, so the screen
      // still names the change it saved, which is now published: read it again, as a person
      // would after publishing from another tab.
      await page.goto(SCREEN, { waitUntil: 'networkidle' });
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
    }
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(toggle).toBeEnabled();
    await publishOwn(page, HERO);
    expect(await plateTag(page, '/')).toContain('class="intro"');
  });
});

test.describe('as developer', () => {
  test.use({ storageState: authFile('developer') });

  test('the look only: no switch', async ({ page }) => {
    await page.goto(SCREEN, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 2, name: 'Style', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save the loading screen' })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Show the loading screen' })).toHaveCount(0);
  });
});
