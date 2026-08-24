import { expect, test, type Page } from '@playwright/test';

/*
 * Hero intro choreography — the regression suite for the logo/headline collision.
 *
 * THE BUG THIS PINS. `.intro` used to be a TRANSPARENT full-viewport layer holding only
 * the centred logo, and `.letter` was deliberately not gated on the intro. So the
 * headline animated in underneath a fully-opaque logo. Whether that read as "layered"
 * or as a collision was decided purely by viewport geometry: the logo is centred and a
 * constant 520x266 above 1131px of width, while the headline is bottom-anchored and
 * grows UPWARD as it wraps. Measured on the shipped build: 122px of ink-on-ink at
 * 1366x768, worst at 1680x900, and clear only at >=1700px where the headline finally
 * fits on two lines. "Works on my friend's wider screen" was literally true and told
 * us the cause.
 *
 * WHY THE WEB ANIMATIONS API AND NOT SCREENSHOTS. A 3.5s choreography sampled at a
 * wall-clock instant flakes on every CI run, and `toHaveScreenshot({animations:
 * 'disabled'})` fast-forwards `fill: both` entrances to their END state — it renders
 * the post-intro frame and tells you nothing about ordering. `page.clock()` fakes
 * Date/timers but NOT the compositor's animation timeline. Seeking every animation to
 * the same `currentTime` (which includes animation-delay) is exactly "T ms into the
 * choreography", and is deterministic on any CPU.
 *
 * HARD CONSTRAINT FOR ANYONE EDITING THIS FILE: never click(), press(), mouse.wheel()
 * or scroll before an ordering assertion — `wheel|touchstart|keydown|pointerdown|
 * focusin` all cut the intro, and the CSS additionally hides the plate on
 * `html:has(:focus-visible)`. Use boundingBox() and evaluate() only.
 */

// The seek is deterministic; a retry would only mask a real regression.
test.describe.configure({ retries: 0, mode: 'parallel' });

/** Freeze the whole choreography at T ms. Two categories are skipped: scroll/view
 *  timeline animations (the slogan band) are PROGRESS-based and throw on an absolute
 *  currentTime, and infinite animations (the scroll cue's pulse, the clients marquee)
 *  have no meaningful position to seek to. */
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

/** Composited opacity — an element inside a faded ancestor is not visible even at
 *  opacity 1, which is exactly the intro-plate case. */
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

/** Every viewport here is a measured boundary, not a decoration. */
const VIEWPORTS = [
  { name: '1366x768 laptop (reported: 122px overlap)', width: 1366, height: 768 },
  { name: '1512x945 MacBook Pro 14 (60px overlap)', width: 1512, height: 945 },
  { name: '1680x900 worst measured case (77px)', width: 1680, height: 900 },
  // 1690 and 1728 straddle the 3-line -> 2-line cliff: a 38px width change used to
  // flip the verdict entirely, which is why a single desktop viewport never caught it.
  { name: '1690x900 just below the wrap cliff', width: 1690, height: 900 },
  { name: '1728x900 just above the wrap cliff', width: 1728, height: 900 },
  { name: '1280x720 Playwright Desktop Chrome default', width: 1280, height: 720 },
  { name: '1920x1080 (cleared by only 46px)', width: 1920, height: 1080 },
  { name: '412x823 Lighthouse mobile emulation', width: 412, height: 823 },
];

const ROUTES = ['/', '/ar'] as const;

const ENTRANCES = [
  '.hero h1 .letter',
  '.hero__sub',
  '.hero__cta',
  '.hero__scroll',
  '.site-header--overlay',
] as const;

for (const route of ROUTES) {
  test.describe(`hero intro — ${route}`, () => {
    for (const vp of VIEWPORTS) {
      test(`the logo never shares the screen with the headline — ${vp.name}`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(route, { waitUntil: 'load' });

        // Sample across the plate's whole life, including the fade.
        for (const t of [200, 600, 1000, 1300, 1600, 1750]) {
          await seek(page, t);
          const plate = await visibility(page, '.intro');
          if (plate <= 0.05) continue;

          const logo = await page.locator('.intro img').boundingBox();
          const h1 = await page.locator('.hero h1').boundingBox();
          expect(logo, 'intro logo must be laid out').not.toBeNull();
          expect(h1, 'headline must be laid out (it is indexable, Tier A)').not.toBeNull();

          // The real invariant is "the headline is not VISIBLE while the plate is up".
          // The opaque plate satisfies it regardless of boxes, but assert the geometry
          // too: it is what catches a regression to a transparent overlay.
          const headline = await visibility(page, '.hero h1 .letter');
          const overlapsY =
            Math.min(logo!.y + logo!.height, h1!.y + h1!.height) - Math.max(logo!.y, h1!.y);
          const overlapsX =
            Math.min(logo!.x + logo!.width, h1!.x + h1!.width) - Math.max(logo!.x, h1!.x);
          const intersects = overlapsY > 0 && overlapsX > 0;

          expect(
            headline < 0.02 || !intersects,
            `t=${t}ms: plate at ${plate} while the headline is at ${headline} and the boxes ` +
              `${intersects ? `intersect by ${Math.round(overlapsY)}x${Math.round(overlapsX)}px` : 'are clear'}`,
          ).toBe(true);
        }
      });
    }

    test('strict order: logo alone, then headline, then sub, then button', async ({ page }) => {
      await page.setViewportSize({ width: 1366, height: 768 });
      await page.goto(route, { waitUntil: 'load' });

      // t=900ms — the logo holds the stage by itself.
      await seek(page, 900);
      expect(await visibility(page, '.intro')).toBeGreaterThan(0.95);
      // The plate must be OPAQUE, not merely timed: this is the assertion that fails if
      // anyone reverts it to a transparent overlay while keeping the new timings.
      const plateBg = await page.evaluate(
        () => getComputedStyle(document.querySelector('.intro')!).backgroundImage,
      );
      expect(plateBg, 'the intro plate must paint the hero backdrop').not.toBe('none');
      for (const sel of ENTRANCES) {
        expect(await visibility(page, sel), `${sel} must not precede the logo`).toBeLessThan(0.02);
      }

      // t=1900ms — the plate is gone and the headline has begun; the button has not.
      await seek(page, 1900);
      expect(await visibility(page, '.intro')).toBeLessThan(0.05);
      expect(await visibility(page, '.hero h1 .letter')).toBeGreaterThan(0.1);
      expect(await visibility(page, '.hero__cta')).toBeLessThan(0.02);

      // t=2600ms — the sub strictly precedes the button. The old CSS could not express
      // this at all: one animation on .hero__side carried both.
      await seek(page, 2600);
      expect(await visibility(page, '.hero__sub')).toBeGreaterThan(0.1);
      expect(await visibility(page, '.hero__cta')).toBeLessThan(0.05);

      // t=3000ms — the tail of the cascade.
      await seek(page, 3000);
      expect(await visibility(page, '.hero__cta')).toBeGreaterThan(0.3);
      expect(await visibility(page, '.hero__scroll')).toBeGreaterThan(0.1);
      expect(await visibility(page, '.site-header--overlay')).toBeGreaterThan(0.1);

      // t=4000ms — settled.
      await seek(page, 4000);
      expect(await visibility(page, '.intro')).toBe(0);
      expect(await visibility(page, '.hero h1 .letter')).toBe(1);
      expect(await visibility(page, '.hero__sub')).toBe(1);
      expect(await visibility(page, '.hero__cta')).toBe(1);
      expect(await visibility(page, '.site-header--overlay')).toBe(1);
      // Exactly .8: `fade-up`'s `to { opacity: 1 }` used to forwards-fill over the
      // static `opacity: .8`, so the cue's intended dim was dead code on every screen.
      expect(await visibility(page, '.hero__scroll')).toBeCloseTo(0.8, 2);
    });

    test('every delay derives from the tokens — no literal may creep back', async ({ page }) => {
      await page.goto(route, { waitUntil: 'load' });

      const t = await page.evaluate(() => {
        const ms = (sel: string, prop: string) => {
          const el = document.querySelector(sel);
          if (!el) return NaN;
          const v = getComputedStyle(el).getPropertyValue(prop).split(',')[0]!.trim();
          return v.endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000;
        };
        // Only LEAF tokens can be read this way. A custom property holding a calc()
        // computes to the unresolved token stream ("calc(1.4s + 0.4s)"), not a time —
        // custom properties are not resolved unless registered via @property. So the
        // derived instants are recomputed here from the leaves the same way the CSS
        // derives them, which is what makes this a real cross-check rather than a
        // tautology.
        const num = (name: string) => {
          const v = getComputedStyle(document.body).getPropertyValue(name).trim();
          return v.endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000;
        };
        const introDelay = ms('.intro', 'animation-delay');
        const introDur = ms('.intro', 'animation-duration');
        const lead = num('--bs-hero-word-step') * 9 + num('--bs-hero-letter-step') * 13;
        return {
          introDelay,
          introDur,
          letter: ms('.hero h1 .word:first-child .letter:first-child', 'animation-delay'),
          sub: ms('.hero__sub', 'animation-delay'),
          cta: ms('.hero__cta', 'animation-delay'),
          cue: ms('.hero__scroll', 'animation-delay'),
          nav: ms('.site-header--overlay', 'animation-delay'),
          heroIn: introDelay + introDur + lead,
          beat: num('--bs-hero-beat'),
        };
      });

      // The handoff: the first letter starts the instant the plate is GONE. This is the
      // assertion that kills the original defect — `.intro { animation-delay: 3.3s }`
      // disagreeing with `--bs-intro-wait: 3.45s`, so the hero entrance began while the
      // logo was still ~76% opaque.
      expect(t.letter).toBeCloseTo(t.introDelay + t.introDur, 1);

      // The cascade is exactly 1 / 2 / 3 beats past the headline's arrival.
      expect(t.sub).toBeCloseTo(t.heroIn + t.beat, 1);
      expect(t.cta).toBeCloseTo(t.heroIn + t.beat * 2, 1);
      expect(t.cue).toBeCloseTo(t.heroIn + t.beat * 3, 1);
      expect(t.nav).toBeCloseTo(t.heroIn + t.beat * 3, 1);
    });

    test('skipping the intro snaps to the end state, it does not pop', async ({ page }) => {
      await page.setViewportSize({ width: 1366, height: 768 });
      await page.goto(route, { waitUntil: 'load' });
      await page.mouse.wheel(0, 1);
      await page.waitForFunction(() => document.body.classList.contains('intro-cut'));

      expect(await visibility(page, '.intro')).toBe(0);
      for (const sel of ENTRANCES) {
        const name = await page.evaluate(
          (s) => getComputedStyle(document.querySelector(s)!).animationName,
          sel,
        );
        // `animation: none` NEUTRALISES rather than retimes. Mutating the delay tokens
        // mid-flight remaps local time onto progress (CSS Animations L1 §4), which is
        // what made the old cut materialise five elements in a single frame.
        expect(name, `${sel} must fall back to its static value, not be retimed`).toBe('none');
      }
      expect(await visibility(page, '.hero h1 .letter')).toBe(1);
      expect(await visibility(page, '.hero__sub')).toBe(1);
      expect(await visibility(page, '.hero__cta')).toBe(1);
      expect(await visibility(page, '.hero__scroll')).toBeCloseTo(0.8, 2);
    });

    test('keyboard focus never lands behind the plate (WCAG 2.4.7)', async ({ page }) => {
      await page.setViewportSize({ width: 1366, height: 768 });
      await page.goto(route, { waitUntil: 'load' });
      await page.keyboard.press('Tab');

      expect(await visibility(page, '.intro')).toBe(0);
      const focused = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        let o = 1;
        for (let n: Element | null = el; n; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
          o *= parseFloat(cs.opacity);
        }
        return Number(o.toFixed(3));
      });
      expect(focused, 'the focused element must be visible').toBe(1);
    });

    test('an LCP candidate is recorded at all', async ({ page }) => {
      await page.setViewportSize({ width: 1366, height: 768 });
      await page.addInitScript(() => {
        (window as unknown as { __lcp: unknown[] }).__lcp = [];
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            (window as unknown as { __lcp: unknown[] }).__lcp.push({
              startTime: e.startTime,
              tag: (e as PerformanceEntry & { element?: Element }).element?.tagName ?? null,
            });
          }
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      });
      await page.goto(route, { waitUntil: 'load' });
      await page.waitForTimeout(5000);

      const lcp = await page.evaluate(
        () => (window as unknown as { __lcp: { startTime: number; tag: string | null }[] }).__lcp,
      );
      // THE assertion: an entry must EXIST. Putting `opacity: 0` on the <h1> BLOCK
      // makes Chromium record no LCP candidate at all — permanently, even after the
      // fade completes — which fails both `categories:performance` and
      // `largest-contentful-paint` in lighthouserc.json. That cliff is almost certainly
      // what the old "gating the headline blows the budget" comment actually hit, and
      // nothing in this repo asserted against it.
      //
      // The NUMERIC 2500ms budget is deliberately NOT duplicated here. Lighthouse is
      // the gate of record for it (lighthouserc.json, throttled, median of N); this
      // suite runs against an unthrottled local wrangler preview that recomputes the
      // /_image transform on demand, where the same page measures 2.0s-5.2s run to run.
      // A flaky duplicate of a real budget teaches people to ignore red. The ceiling
      // below is a smoke-detector for a catastrophic regression, not a budget.
      expect(lcp.length, 'no LCP candidate was recorded at all').toBeGreaterThan(0);
      const last = lcp[lcp.length - 1]!;
      expect(last.startTime, `LCP element was <${last.tag}>`).toBeLessThan(8000);
    });
  });
}

test.describe('reduced motion', () => {
  for (const route of ROUTES) {
    test(`no intro, and every entrance is left VISIBLE — ${route}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize({ width: 1366, height: 768 });
      await page.goto(route, { waitUntil: 'load' });

      expect(await visibility(page, '.intro')).toBe(0);
      // The landmine this guards: the reduced-motion block reveals entrances by KILLING
      // their animation, which works only because the hidden from-state lives inside
      // @keyframes. Adding a static `opacity: 0` to .hero h1 / .word / .letter would
      // ship a permanently blank headline to every reduced-motion user, and axe has no
      // rule for "visible text at opacity 0".
      expect(await visibility(page, '.hero h1 .letter')).toBe(1);
      expect(await visibility(page, '.hero__sub')).toBe(1);
      expect(await visibility(page, '.hero__cta')).toBe(1);
      expect(await visibility(page, '.site-header--overlay')).toBe(1);
      expect(await visibility(page, '.hero__scroll')).toBeCloseTo(0.8, 2);
    });
  }
});
