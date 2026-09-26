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

/** The choreography's instants, recomputed from the LEAF tokens exactly as global.css
 *  derives them (a custom property holding a calc() computes to its token stream, not a
 *  time, so the derived ones cannot be read directly). Seeking at instants derived from
 *  the same tokens keeps these tests meaningful when the intro is retimed — they fail on
 *  a broken ORDER, not on a new number. */
async function timeline(page: Page) {
  return page.evaluate(() => {
    const num = (name: string) => {
      const v = getComputedStyle(document.body).getPropertyValue(name).trim();
      return v.endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000;
    };
    const hold = num('--bs-intro-hold');
    const wait = hold + num('--bs-intro-fade');
    const heroIn = wait + num('--bs-hero-word-step') * 9 + num('--bs-hero-letter-step') * 13;
    const beat = num('--bs-hero-beat');
    return {
      hold,
      wait,
      heroIn,
      beat,
      sub: heroIn + beat,
      cta: heroIn + beat * 2,
      tail: heroIn + beat * 3,
    };
  });
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
        const { hold, wait } = await timeline(page);
        for (const t of [200, hold * 0.6, hold, (hold + wait) / 2, wait - 50]) {
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
      const t = await timeline(page);

      // The logo holds the stage by itself (it has finished its own .45s entrance).
      await seek(page, t.hold * 0.7);
      expect(await visibility(page, '.intro')).toBeGreaterThan(0.95);
      // The overlay is deliberately TRANSPARENT so the hero loop plays under the logo,
      // which means the ONLY thing keeping the headline off the screen is the time gate.
      // These assertions are the real protection against the original ink-on-ink
      // collision, not a nice-to-have.
      for (const sel of ENTRANCES) {
        expect(await visibility(page, sel), `${sel} must not precede the logo`).toBeLessThan(0.02);
      }

      // The plate is gone and the headline has begun; the button has not.
      await seek(page, t.wait + 150);
      expect(await visibility(page, '.intro')).toBeLessThan(0.05);
      expect(await visibility(page, '.hero h1 .letter')).toBeGreaterThan(0.1);
      expect(await visibility(page, '.hero__cta')).toBeLessThan(0.02);

      // The sub strictly precedes the button (one beat apart). The old CSS could not
      // express this at all: one animation on .hero__side carried both.
      await seek(page, t.sub + 120);
      expect(await visibility(page, '.hero__sub')).toBeGreaterThan(0.1);
      expect(await visibility(page, '.hero__cta')).toBeLessThan(0.05);

      // The tail of the cascade.
      await seek(page, t.tail + 300);
      expect(await visibility(page, '.hero__cta')).toBeGreaterThan(0.3);
      expect(await visibility(page, '.hero__scroll')).toBeGreaterThan(0.1);
      expect(await visibility(page, '.site-header--overlay')).toBeGreaterThan(0.1);

      // Settled.
      await seek(page, t.tail + 1500);
      expect(await visibility(page, '.intro')).toBe(0);
      expect(await visibility(page, '.hero h1 .letter')).toBe(1);
      expect(await visibility(page, '.hero__sub')).toBe(1);
      expect(await visibility(page, '.hero__cta')).toBe(1);
      expect(await visibility(page, '.site-header--overlay')).toBe(1);
      // Exactly .8: `fade-up`'s `to { opacity: 1 }` used to forwards-fill over the
      // static `opacity: .8`, so the cue's intended dim was dead code on every screen.
      expect(await visibility(page, '.hero__scroll')).toBeCloseTo(0.8, 2);
    });

    test("the retime is the mockup's: 1.0s hold, .45s fade, .45s logo, .9s letters", async ({
      page,
    }) => {
      // UI v2 decision 5. The derived-order tests above pass for ANY timing; this pins the
      // numbers the owner approved, so a retime is a visible diff here, not a silent drift.
      await page.goto(route, { waitUntil: 'load' });
      const t = await timeline(page);
      expect(t.hold).toBe(1000);
      expect(t.wait).toBe(1450);
      const anim = await page.evaluate(() => {
        const dur = (sel: string) =>
          getComputedStyle(document.querySelector(sel)!).animationDuration;
        return { logo: dur('.intro img'), letter: dur('.hero h1 .letter') };
      });
      expect(anim).toEqual({ logo: '0.45s', letter: '0.9s' });
    });

    test("the logo carries the mockup's drop-shadow, and never an animated blur", async ({
      page,
    }) => {
      await page.goto(route, { waitUntil: 'load' });
      const filter = await page.evaluate(
        () => getComputedStyle(document.querySelector('.intro img')!).filter,
      );
      expect(filter).toContain('drop-shadow');
      // blur() is outside the compositor-only set and this is the LCP image.
      expect(filter).not.toContain('blur');
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

/*
 * The plate is a stopwatch; the logo is a runtime image transform. Measured on
 * production, a warm edge returns it in ~0.7s and a COLD one in ~3.5s — so with a fixed
 * 1.8s plate the logo lost its own race and users saw a blank backdrop followed by the
 * headline. The previous 4.2s timeline only hid this by accident, by outlasting the
 * cold fetch. These tests pin the gate that removed the race, including the two ways it
 * must never fail closed.
 */
test.describe('the intro waits for the logo to actually paint', () => {
  test('a cold/slow logo holds the plate instead of lifting without it', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    // The delay must EXCEED the plate's own life (hold + fade), or this test proves
    // nothing: with a long hold the plate would still be up at the sample point whether
    // the gate exists or not. Keep this comfortably above --bs-intro-wait if the intro
    // is ever retimed again.
    await page.route('**/_image*', async (route) => {
      await new Promise((r) => setTimeout(r, 5000));
      await route.continue();
    });
    // Record the gate from INSIDE the page. Sampling it from the test at a fixed delay
    // raced the page under load: the check could land after the 2s cap had already (and
    // correctly) released it. The recorder sees every frame of the gate's life instead.
    await page.addInitScript(() => {
      const gate = { engagedAt: -1, releasedAt: -1, minPlate: 1 };
      (window as unknown as { __gate: typeof gate }).__gate = gate;
      const plate = () => {
        const el = document.querySelector('.intro');
        return el ? parseFloat(getComputedStyle(el).opacity) : 1;
      };
      const frame = () => {
        const waiting = document.body?.classList.contains('intro-waiting') ?? false;
        if (waiting && gate.engagedAt < 0) gate.engagedAt = performance.now();
        if (waiting) gate.minPlate = Math.min(gate.minPlate, plate());
        if (!waiting && gate.engagedAt >= 0 && gate.releasedAt < 0) {
          gate.releasedAt = performance.now();
          return;
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    await page.goto('/', { waitUntil: 'commit' });
    await page.waitForSelector('.intro img', { timeout: 20_000 });

    // The gate must actually engage while the logo is outstanding, hold the plate
    // (no fade while waiting), and wait for the logo up to its cap rather than a frame.
    await page.waitForFunction(
      () => (window as unknown as { __gate: { releasedAt: number } }).__gate.releasedAt >= 0,
      null,
      { timeout: 10_000 },
    );
    const gate = await page.evaluate(
      () =>
        (
          window as unknown as {
            __gate: { engagedAt: number; releasedAt: number; minPlate: number };
          }
        ).__gate,
    );
    expect(gate.engagedAt, 'the paint gate never engaged').toBeGreaterThanOrEqual(0);
    expect(gate.minPlate, 'plate faded while waiting for the logo').toBeGreaterThan(0.9);
    // Released by the 3s cap (the logo is held for 5s), not immediately.
    expect(gate.releasedAt - gate.engagedAt).toBeGreaterThan(2500);
  });

  test('a slow logo is actually SEEN on the plate — decoded, not just faded in', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    // Slower than warm, well inside CAP + hold (4.0s): the load event — not the cap —
    // releases the gate, while the plate is still holding.
    await page.route('**/_image*', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await page.goto('/', { waitUntil: 'commit' });
    await page.waitForSelector('.intro img', { timeout: 20_000 });

    // A frame where the plate is up AND the logo has real pixels. Opacity alone is not
    // enough: once the gate releases, an image element fades in whether or not its bytes
    // have arrived — which is how this used to pass with no logo ever painted.
    const seenOnPlate = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const vis = (sel: string) => {
            const el = document.querySelector(sel);
            if (!el) return 0;
            let o = 1;
            for (let n: Element | null = el; n; n = n.parentElement) {
              const cs = getComputedStyle(n);
              if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
              o *= parseFloat(cs.opacity);
            }
            return o;
          };
          const tick = () => {
            const img = document.querySelector<HTMLImageElement>('.intro img');
            const painted = !!img && img.complete && img.naturalWidth > 0;
            if (vis('.intro') > 0.5 && painted && vis('.intro img') > 0.5) return resolve(true);
            // The plate is gone and we never caught the logo on it — the race was lost.
            if (vis('.intro') === 0) return resolve(false);
            requestAnimationFrame(tick);
          };
          tick();
        }),
    );
    expect(seenOnPlate, 'the plate lifted without the logo ever being painted on it').toBe(true);
  });

  test('a logo that never loads still releases — it cannot wedge the page', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.route('**/_image*', (route) => route.abort());
    await page.goto('/', { waitUntil: 'commit' });
    await page.waitForSelector('.hero h1', { timeout: 20_000 });

    // An opaque, full-viewport, pointer-capturing plate that never lifts is the worst
    // failure this feature can have. The cap and the already-settled `complete` check
    // are the two things standing between a broken image and an unusable home page.
    await page.waitForFunction(() => !document.body.classList.contains('intro-waiting'), null, {
      timeout: 6000,
    });
    await page.waitForFunction(
      () => {
        const el = document.querySelector('.intro');
        return (
          !el || getComputedStyle(el).opacity === '0' || getComputedStyle(el).display === 'none'
        );
      },
      null,
      { timeout: 8000 },
    );
    // Wait for the entrance to FINISH rather than sampling it mid-fade. The claim under
    // test is that the page becomes usable at all, not how far along it is at one
    // instant — asserting immediately after the plate clears catches the letters at
    // ~0.3 and fails for a reason that has nothing to do with the broken logo.
    await page.waitForFunction(
      () => {
        const el = document.querySelector('.hero h1 .letter');
        return !!el && parseFloat(getComputedStyle(el).opacity) > 0.9;
      },
      null,
      { timeout: 8000 },
    );
    expect(await visibility(page, '.hero h1 .letter')).toBeGreaterThan(0.9);
  });
});

test.describe('a deep link skips the intro', () => {
  for (const route of ['/#services', '/ar#services']) {
    test(`${route} lands on its section, not under the logo plate`, async ({ page }) => {
      await page.setViewportSize({ width: 1366, height: 768 });
      await page.goto(route, { waitUntil: 'load' });
      await page.waitForFunction(() => document.body.classList.contains('intro-cut'));
      expect(await visibility(page, '.intro')).toBe(0);
      // Cut WITHOUT spending the once-per-session intro: the next visit to the top of home
      // still gets the brand moment.
      expect(await page.evaluate(() => sessionStorage.getItem('bs_intro'))).toBeNull();
    });
  }
});

test.describe('the intro never absorbs a click meant for something else', () => {
  // The plate is a full-viewport fixed layer at z-90. The PDPL consent banner is at
  // z-80, i.e. UNDERNEATH it. While the plate was `pointer-events: auto` a click on
  // "Accept analytics" during the intro was swallowed: the intro cut, no
  // `__Host-consent` cookie was written, and the banner stayed open with no feedback —
  // the visitor's consent choice was silently lost on every first visit.
  //
  // This must use RAW mouse events. Playwright's click() runs actionability checks and
  // retries, which papers over exactly this defect and reports a pass.
  test('a consent click during the intro is recorded, not eaten', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/', { waitUntil: 'load' });
    await page.waitForTimeout(300); // plate is up (it holds for 1.0s, then fades)

    const box = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) =>
        /accept/i.test(b.textContent || ''),
      );
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    expect(box, 'consent banner must be present on a first visit').not.toBeNull();

    await page.mouse.move(box!.x, box!.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(600);

    const after = await page.evaluate(() => ({
      consent: document.cookie.includes('__Host-consent'),
      bannerOpen:
        !!document.querySelector('.consent-banner') &&
        !document.querySelector('.consent-banner')!.hasAttribute('hidden'),
    }));
    expect(after.consent, 'consent was not recorded — the intro absorbed the click').toBe(true);
    expect(after.bannerOpen, 'banner should close once the choice is made').toBe(false);
  });

  // The other half of the same trade: with the plate now click-through, a click during
  // the intro must not activate a hero control that has not arrived yet and cannot be
  // seen. The entrance keyframes carry `pointer-events: none` in their from-state.
  test('an invisible hero CTA cannot be clicked before it arrives', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/', { waitUntil: 'load' });
    await seek(page, 1000);
    const pe = await page.evaluate(
      () => getComputedStyle(document.querySelector('.hero__cta')!).pointerEvents,
    );
    expect(pe, 'the CTA is invisible at t=1000ms and must not be clickable').toBe('none');
  });
});

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
