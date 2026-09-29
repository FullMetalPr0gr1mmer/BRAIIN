import { expect, test, type Page } from '@playwright/test';

/*
 * The header's motion switch (Round 3, R3-7 — the WCAG 2.2.2 control that closed EXC-007).
 *
 * One button, on every page, after the language pill: pressed, it stops everything that
 * moves on its own — the background loops (hero, slogan band, banners), the in-content
 * clips (cards, frames, the explorer), the clients marquee, the hero scroll cue, the
 * banner caption's pulse — and puts the testimonials carousel into its own paused state.
 * The choice is remembered per tab. axe cannot see any of this (no rule decides whether
 * autoplaying content has a pause mechanism), which is why it is asserted here.
 *
 * Against the seeded local database (CI): home has the hero loop, the marquee, the cards
 * and the carousel; /services the card and explorer clips; /portfolio the banner and its
 * caption dot.
 */

const BTN = '[data-motion-toggle]';

const LABEL = { en: 'Pause motion', ar: 'إيقاف الحركة' } as const;

// Home's intro plate is a timed overlay; these tests start as a returning visitor.
async function skipIntro(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      sessionStorage.setItem('bs_intro', '1');
    } catch {
      /* storage blocked: the intro still ends on its own */
    }
  });
}

// A visitor whose tab already holds the choice (what a navigation restores).
async function seedPaused(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      sessionStorage.setItem('bs_motion', 'paused');
    } catch {
      /* storage blocked: playing */
    }
  });
}

/** The hero mounts its loop after `load`; give the deferred module a beat. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('load');
  await page.waitForTimeout(1500);
}

async function scrollThrough(page: Page): Promise<void> {
  const height = await page.evaluate(() => document.scrollingElement!.scrollHeight);
  const step = await page.evaluate(() => Math.round(innerHeight * 0.6));
  for (let y = 0; y <= height; y += step) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(800);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
}

const playState = (page: Page, selector: string, pseudo?: string) =>
  page.evaluate(
    ([sel, ps]) => {
      const el = document.querySelector(sel!);
      return el ? getComputedStyle(el, ps ?? null).animationPlayState : null;
    },
    [selector, pseudo] as const,
  );

const allPaused = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll('video')].every((v) => v.paused));

test.beforeEach(async ({ page }) => {
  await skipIntro(page);
});

for (const locale of ['en', 'ar'] as const) {
  const home = locale === 'ar' ? '/ar' : '/';
  const contact = locale === 'ar' ? '/ar/contact' : '/contact';
  const services = locale === 'ar' ? '/ar/services' : '/services';

  test(`one fixed accessible name and a pressed state — ${locale}`, async ({ page }) => {
    await page.goto(contact);
    const btn = page.locator(BTN);
    await expect(btn).toBeVisible();
    await expect(btn).toHaveAttribute('aria-label', LABEL[locale]);
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await expect(btn).toHaveAttribute('type', 'button');
    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    // The label never changes — the state is `aria-pressed` (APG toggle button), not a
    // swapped name, which the removed hero control got wrong.
    await expect(btn).toHaveAttribute('aria-label', LABEL[locale]);
    await expect(page.locator('body')).toHaveClass(/motion-paused/);
    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('body')).not.toHaveClass(/motion-paused/);
  });

  test(`Space and Enter toggle it — ${locale}`, async ({ page }) => {
    await page.goto(contact);
    const btn = page.locator(BTN);
    await btn.focus();
    await page.keyboard.press('Space');
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Enter');
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  test(`a tap toggles it — ${locale}`, async ({ browser }) => {
    const ctx = await browser.newContext({ hasTouch: true, viewport: { width: 412, height: 823 } });
    const page = await ctx.newPage();
    await skipIntro(page);
    await page.goto(contact);
    await page.tap(BTN);
    await expect(page.locator(BTN)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('body')).toHaveClass(/motion-paused/);
    await ctx.close();
  });

  test(`it sits at the inline end of the language pill — ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 800 });
    await page.goto(contact);
    const box = async (sel: string) => (await page.locator(sel).boundingBox())!;
    const lang = await box('.site-header__lang');
    const btn = await box(BTN);
    if (locale === 'ar') expect(btn.x + btn.width).toBeLessThanOrEqual(lang.x);
    else expect(btn.x).toBeGreaterThanOrEqual(lang.x + lang.width);
    // Beside it, not spread away from it, and on the same line.
    const gap = locale === 'ar' ? lang.x - (btn.x + btn.width) : btn.x - (lang.x + lang.width);
    expect(gap).toBeLessThanOrEqual(12);
    expect(Math.abs(btn.y + btn.height / 2 - (lang.y + lang.height / 2))).toBeLessThan(2);
    expect(btn.width).toBe(32);
    expect(btn.height).toBe(32);
  });

  test(`paused: every video stops, the marquee and the scroll cue hold — ${locale}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1366, height: 800 });
    await page.goto(home, { waitUntil: 'load' });
    await settle(page);
    await expect(page.locator('.hero__media video')).toHaveCount(1);
    await expect
      .poll(() =>
        page.locator('.hero__media video').evaluate((v) => (v as HTMLVideoElement).paused),
      )
      .toBe(false);
    expect(await playState(page, '.hero__scroll i')).toBe('running');

    await page.locator(BTN).click();
    await expect.poll(() => allPaused(page)).toBe(true);
    expect(await playState(page, '.hero__scroll i')).toBe('paused');
    // The marquee is below the fold; its animation state is a style, so no scroll needed.
    await page.mouse.move(1, 1); // `.marquee:hover` also pauses it — keep the pointer away
    expect(await playState(page, '.marquee-track')).toBe('paused');
  });

  test(`resume plays the on-screen hero only — ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 800 });
    await seedPaused(page);
    await page.goto(home, { waitUntil: 'load' });
    await settle(page);
    // A paused visitor's page mounted nothing (no bytes) — the mount was deferred.
    await expect(page.locator(BTN)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('video')).toHaveCount(0);

    await page.locator(BTN).click();
    const hero = page.locator('.hero__media video');
    await expect(hero).toHaveCount(1);
    await expect.poll(() => hero.evaluate((v) => (v as HTMLVideoElement).paused)).toBe(false);
    // The slogan band is below the fold: still no video there.
    await expect(page.locator('.slogan__media video')).toHaveCount(0);
    expect(await playState(page, '.hero__scroll i')).toBe('running');
  });

  test(`a full scroll while paused creates no clip, and a hovered card plays nothing — ${locale}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1366, height: 900 });
    await seedPaused(page);
    const seen: string[] = [];
    page.on('request', (r) => {
      if (r.resourceType() === 'media' || /\.(mp4|webm)(\?|$)/i.test(r.url())) seen.push(r.url());
    });
    await page.goto(services, { waitUntil: 'load' });
    await settle(page);
    await page.mouse.move(1, 1);
    await scrollThrough(page);
    expect(await page.locator('video').count()).toBe(0);

    // Hover clips are covered too: simpler and stricter than arguing a hover is
    // user-initiated. The card must be on screen (and its rise finished) to hover it.
    await page.evaluate(() => document.getElementById('consent-banner')?.remove());
    const card = page.locator('.disc-card[data-disc="events"]');
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(700);
    await card.hover();
    await page.waitForTimeout(600);
    expect(await page.locator('.disc-card video').count()).toBe(0);
    expect(seen, 'video requested while paused').toEqual([]);
  });

  test(`the choice survives navigation, not a new tab — ${locale}`, async ({ page, browser }) => {
    await page.goto(contact);
    await page.locator(BTN).click();
    await expect(page.locator(BTN)).toHaveAttribute('aria-pressed', 'true');
    await page.goto(home, { waitUntil: 'load' });
    await expect(page.locator(BTN)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('body')).toHaveClass(/motion-paused/);
    await settle(page);
    await expect(page.locator('video')).toHaveCount(0);

    // sessionStorage is per tab: a new context starts playing.
    const ctx = await browser.newContext();
    const fresh = await ctx.newPage();
    await skipIntro(fresh);
    await fresh.goto(contact);
    await expect(fresh.locator(BTN)).toHaveAttribute('aria-pressed', 'false');
    await expect(fresh.locator('body')).not.toHaveClass(/motion-paused/);
    await ctx.close();
  });

  test(`hidden under reduced motion — ${locale}`, async ({ page }) => {
    // Nothing moves on its own there (no video mounts, the loops are static), so a pause
    // control would be a control over nothing. Hidden by CSS, not removed: the markup is
    // the same for every visitor (Tier A).
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(contact);
    await expect(page.locator(BTN)).toHaveCount(1);
    await expect(page.locator(BTN)).toBeHidden();
  });

  test(`the carousel shows Play after a global pause; only its own Play restarts it — ${locale}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1366, height: 800 });
    await page.goto(home, { waitUntil: 'load' });
    await page.evaluate(() => document.getElementById('consent-banner')?.remove());
    const band = page.locator('#testimonials[data-carousel]');
    await expect(band).toHaveCount(1);
    const toggle = band.locator('[data-toggle]');
    const playLabel = locale === 'ar' ? 'تشغيل تبديل الآراء' : 'Play the testimonials';
    const pauseLabel = locale === 'ar' ? 'إيقاف تبديل الآراء' : 'Pause the testimonials';

    // Global pause, then arrive at the carousel: its own control says Play, honestly.
    await page.locator(BTN).click();
    await band.scrollIntoViewIfNeeded();
    await page.mouse.move(1, 1);
    await page.waitForTimeout(500);
    await expect(toggle).toHaveAttribute('aria-label', playLabel);
    await expect(toggle).toHaveClass(/is-play/);
    await expect(band).toHaveClass(/is-paused/);

    // A global resume leaves it stopped (APG: only its own Play restarts it). The header
    // is off screen down here, so the resume is the same click, dispatched.
    await page.evaluate(() =>
      (document.querySelector('[data-motion-toggle]') as HTMLElement).click(),
    );
    await expect(page.locator('body')).not.toHaveClass(/motion-paused/);
    await page.waitForTimeout(300);
    await expect(toggle).toHaveAttribute('aria-label', playLabel);
    await expect(band).toHaveClass(/is-paused/);

    // Its own Play restarts it (the pointer then leaves, since hover pauses too).
    await toggle.click();
    await page.mouse.move(1, 1);
    await expect(toggle).toHaveAttribute('aria-label', pauseLabel);
    await expect(band).not.toHaveClass(/is-paused/);
  });
}

for (const path of ['/portfolio', '/ar/portfolio']) {
  test(`${path}: the banner loop and the caption dot stop`, async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 800 });
    await page.goto(path, { waitUntil: 'load' });
    await settle(page);
    const banner = page.locator('[data-banner] video');
    await expect(banner).toHaveCount(1);
    await expect.poll(() => banner.evaluate((v) => (v as HTMLVideoElement).paused)).toBe(false);
    expect(await playState(page, '.work-cap__live', '::after')).toBe('running');

    await page.locator(BTN).click();
    await expect.poll(() => allPaused(page)).toBe(true);
    expect(await playState(page, '.work-cap__live', '::after')).toBe('paused');

    await page.locator(BTN).click();
    await expect.poll(() => banner.evaluate((v) => (v as HTMLVideoElement).paused)).toBe(false);
    expect(await playState(page, '.work-cap__live', '::after')).toBe('running');
  });
}

test('a mouse click on the switch does not keep the header from hiding on scroll', async ({
  page,
}) => {
  // Both halves count keyboard focus only (`:focus-visible`): the script's "in use" check
  // and the CSS restore of a hidden bar. Focus left on the button by a click used to pin
  // the bar for the rest of the scroll. The visible state is the transform, not the class.
  await page.setViewportSize({ width: 1366, height: 800 });
  await page.goto('/privacy');
  await page.evaluate(() => {
    document.body.style.minHeight = '4000px';
  });
  await page.locator(BTN).click();
  await page.locator(BTN).click(); // back to playing; focus stays on the button
  await page.mouse.wheel(0, 900);
  const header = page.locator('.site-header');
  await expect(header).toHaveClass(/is-hidden/);
  await expect.poll(() => header.evaluate((el) => getComputedStyle(el).transform)).not.toBe('none');
});
