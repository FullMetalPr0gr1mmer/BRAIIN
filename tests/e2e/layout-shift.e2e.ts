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
 * S3 adds the /services cases (the page-mode cards, the explorer opening, /services#events).
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
  sources: string[];
}

/** Starts collecting layout shifts that happen from now on (buffered, so none is missed). */
async function watchShifts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __shifts: Shift[] };
    w.__shifts = [];
    const since = performance.now();
    type Entry = PerformanceEntry & {
      value: number;
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
  });
}

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
