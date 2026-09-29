import { expect, test, type Page } from '@playwright/test';

/*
 * Hover CLS — Round 2's discipline cards (ServicesOverview.astro, global.css "Discipline
 * cards").
 *
 * The design widens a card under the pointer with flex-grow, which moves every neighbour on
 * every frame of a .75 s transition. Hover is NOT "recent input" for the Layout Instability
 * API (only mousedown, pointerdown and keydown are), so each of those frames would count
 * toward the page's field CLS. Lighthouse runs in the lab without a pointer and cannot see
 * any of it — this file is the only gate. The port places the cards with `translate` and
 * cuts their width with `clip-path`; the sum over a full sweep must be exactly 0.
 *
 * /services (Round 2, S3): the page-mode cards get the same sweep; opening an explorer panel
 * by a card click must shift nothing that COUNTS (the open is instant, inside the click's
 * 500 ms input window, so its own shift is excluded exactly as field CLS excludes it —
 * `hadRecentInput` — and nothing may keep moving after that window); and a deep link to
 * /services#events must open Events at first paint, with no shift at all from navigation on.
 */

// The home intro is a timed plate over everything; start as a returning visitor.
async function skipIntro(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      sessionStorage.setItem('bs_intro', '1');
    } catch {
      /* storage blocked: the intro still ends on its own */
    }
  });
}

interface Shift {
  value: number;
  /** Within 500 ms of a discrete input (click, key): field CLS excludes it. */
  recent: boolean;
  sources: string[];
}

/** Starts collecting layout shifts that happen from now on (buffered, so none is missed);
    `fromStart` collects every one since navigation. */
async function watchShifts(page: Page, fromStart = false): Promise<void> {
  await page.evaluate((all) => {
    const w = window as unknown as { __shifts: Shift[] };
    w.__shifts = [];
    const since = all ? 0 : performance.now();
    type Entry = PerformanceEntry & {
      value: number;
      hadRecentInput: boolean;
      sources?: {
        node?: Node | null;
        previousRect: DOMRectReadOnly;
        currentRect: DOMRectReadOnly;
      }[];
    };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as Entry[]) {
        if (e.startTime < since) continue;
        w.__shifts.push({
          value: e.value,
          recent: e.hadRecentInput,
          // "parent-classes > tag.classes", so a failure names what moved.
          sources: (e.sources ?? []).map((s) => {
            const el = s.node instanceof Element ? s.node : s.node?.parentElement;
            const name = (n: Element | null | undefined) =>
              n ? `${n.tagName.toLowerCase()}.${[...n.classList].join('.')}` : '?';
            const r = (x: DOMRectReadOnly) =>
              [x.x, x.y, x.width, x.height].map((v) => Math.round(v)).join(',');
            return el
              ? `${name(el.parentElement)} > ${name(el)} ${r(s.previousRect)} → ${r(s.currentRect)}`
              : '?';
          }),
        });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  }, fromStart);
}

/** The shifts CLS counts (the ones with no recent input), summed. */
const counted = (seen: Shift[]) =>
  seen.filter((s) => !s.recent).reduce((sum, s) => sum + s.value, 0);

async function shifts(page: Page): Promise<Shift[]> {
  return page.evaluate(() => (window as unknown as { __shifts: Shift[] }).__shifts);
}

/** Parks the stage mid-screen, where the scroll-driven rise has finished, and settles. */
async function park(page: Page, stageSelector: string): Promise<void> {
  await page.locator(stageSelector).scrollIntoViewIfNeeded();
  await page.evaluate((sel) => {
    const r = document.querySelector(sel)!.getBoundingClientRect();
    window.scrollBy(0, r.top - (innerHeight - r.height) / 2);
  }, stageSelector);
  await page.mouse.move(2, 2);
  await page.waitForTimeout(900);
}

/** Moves the mouse to the middle of a card's link — always inside its visible part. */
async function pointAt(page: Page, stageSelector: string, i: number): Promise<void> {
  const b = (await page.locator(`${stageSelector} > .disc-card`).nth(i).boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
}

/** Moves the mouse across the stage, card by card, in both directions, pausing on each. */
async function sweep(page: Page, stageSelector: string): Promise<number> {
  const stage = page.locator(stageSelector);
  await park(page, stageSelector);
  await watchShifts(page);

  const box = (await stage.boundingBox())!;
  const y = box.y + box.height / 2;
  const steps = 48;
  for (const dir of [1, -1]) {
    for (let i = 0; i <= steps; i++) {
      const t = dir === 1 ? i / steps : 1 - i / steps;
      await page.mouse.move(box.x + 4 + t * (box.width - 8), y);
      await page.waitForTimeout(35);
    }
    await page.waitForTimeout(900);
  }
  // ...then rest on each card long enough for its transition to finish.
  const cards = await page.locator(`${stageSelector} > .disc-card`).count();
  for (let i = 0; i < cards; i++) {
    await pointAt(page, stageSelector, i);
    await page.waitForTimeout(900);
  }
  await page.mouse.move(2, 2);
  await page.waitForTimeout(900);
  return cards;
}

for (const locale of ['en', 'ar'] as const) {
  const root = locale === 'ar' ? '/ar' : '/';

  test(`home discipline cards: a full hover sweep shifts nothing — ${locale}`, async ({ page }) => {
    test.setTimeout(90_000);
    await skipIntro(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(root, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);

    const cards = await sweep(page, '#services .disc__stage');
    expect(cards).toBe(5);

    const seen = await shifts(page);
    const total = seen.reduce((sum, s) => sum + s.value, 0);
    expect(total, `layout shifts during the sweep: ${JSON.stringify(seen)}`).toBe(0);
  });

  test(`home discipline cards: the hovered card really widens — ${locale}`, async ({ page }) => {
    // The guard for the test above: a sweep over cards that never widen would also shift
    // nothing. The widen is a clip on the card's visual layer.
    await skipIntro(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(root, { waitUntil: 'load' });
    await park(page, '#services .disc__stage');
    const card = page.locator('#services .disc-card').nth(1);
    const ring = card.locator('.disc-card__ring');
    const rest = (await ring.boundingBox())!.width;
    await pointAt(page, '#services .disc__stage', 1);
    await page.waitForTimeout(1000);
    const wide = (await ring.boundingBox())!.width;
    expect(wide / rest).toBeGreaterThan(1.8);
    // The link's own box never moves or resizes: only transforms and the clip did.
    const linkBefore = await card.evaluate((el) => (el as HTMLElement).offsetWidth);
    await page.mouse.move(2, 2);
    await page.waitForTimeout(1000);
    expect(await card.evaluate((el) => (el as HTMLElement).offsetWidth)).toBe(linkBefore);
    expect((await ring.boundingBox())!.width).toBeCloseTo(rest, 0);
  });
}

// ── /services (Round 2, S3) ─────────────────────────────────────────────────────────

for (const locale of ['en', 'ar'] as const) {
  const path = locale === 'ar' ? '/ar/services' : '/services';

  test(`services discipline cards: a full hover sweep shifts nothing — ${locale}`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(path, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);

    const cards = await sweep(page, '#categories .disc__stage');
    expect(cards).toBe(5);

    const seen = await shifts(page);
    const total = seen.reduce((sum, s) => sum + s.value, 0);
    expect(total, `layout shifts during the sweep: ${JSON.stringify(seen)}`).toBe(0);
  });

  test(`services explorer: opening a panel by a card click counts no shift — ${locale}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(path, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => document.getElementById('consent-banner')?.remove());
    await park(page, '#categories .disc__stage');
    await watchShifts(page);

    await pointAt(page, '#categories .disc__stage', 2);
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.locator('.svc-panel.is-active')).toHaveCount(1);
    // Past the 500 ms input window and the body's entrance, the page must be still.
    await page.waitForTimeout(1500);
    // ...and switching panels by keyboard is the same instant swap.
    await page.locator('[role="tab"][aria-selected="true"]').focus();
    await page.keyboard.press('End');
    await page.waitForTimeout(1500);

    const seen = await shifts(page);
    expect(counted(seen), `counted layout shifts: ${JSON.stringify(seen)}`).toBe(0);
  });

  test(`services explorer: /services#events opens at first paint, no shift — ${locale}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1366, height: 900 });
    // Warm the font cache first (a returning visitor): load the page once, then the deep link
    // as a NEW document (the query makes it one; the route ignores it). A COLD Arabic visit
    // also shifts the banner copy and the numbers when Almarai (and its Latin subset, the
    // digits) replaces the metric-matched fallback, whose advance widths differ — ≈0.01, the
    // site-wide web-font swap /ar/contact shows too. That is not the explorer's to fix, and
    // it would hide what this test is for: the explorer's own opening and hand-over.
    await page.goto(path, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.goto(`${path}?warm=1#events`, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await watchShifts(page, true);
    await page.waitForTimeout(1500);
    await expect(page.locator('.svc-panel#events')).toBeVisible();
    const seen = await shifts(page);
    const total = seen.reduce((sum, s) => sum + s.value, 0);
    expect(total, `layout shifts since navigation: ${JSON.stringify(seen)}`).toBe(0);
  });
}

// Cold loads at Lighthouse's desktop viewport: the web fonts are not cached (a fresh
// context per test), so this is the visit where a late font swap can move the page.
// Two mechanisms shipped in Round 2 and were only caught after the deploy (Round 3, E):
//   - a `ch`-unit cap on a swap-font heading (About's h1: 540 px → 597 px when Almarai
//     replaced the fallback, CLS 0.034–0.14 on /ar/about);
//   - the Almarai fallback is metric-matched for LATIN glyphs only, so every non-preloaded
//     weight re-wrapped Arabic nav links, kickers and filter chips on arrival — on
//     /ar/portfolio/all, whose header is in flow, that pushed the whole catalogue
//     (CLS 0.13–0.26). The fallback is now six faces, per weight and per script, so the
//     swap keeps every line where it was (`font-display: optional` was rejected: it puts
//     the Arabic files on the LCP chain).
// Lighthouse's 3-run median can miss a race; this names the element on the first failure.
// 0.02 is the documented site-wide allowance for a metric-mismatched swap (≈0.01).
for (const path of ['/about', '/ar/about', '/portfolio/all', '/ar/portfolio/all']) {
  test(`cold desktop load is still: ${path}`, async ({ page }) => {
    await page.setViewportSize({ width: 1350, height: 940 });
    await page.goto(path, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await watchShifts(page, true);
    await page.waitForTimeout(1500);
    const seen = await shifts(page);
    expect(
      counted(seen),
      `counted layout shifts since navigation: ${JSON.stringify(seen)}`,
    ).toBeLessThan(0.02);
  });
}
