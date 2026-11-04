import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { INTRO_DEFAULTS, INTRO_FADE, INTRO_HOLD, stepValues } from '@schemas/appearance';
import { INTRO_LIFT_FLOOR_MS, INTRO_NO_HOLD_CAP_MS, introHoldCap } from '@/lib/client/introGate';

// The home intro's logo wait (Hero.astro's gate, docs/hero-intro.md §3) against every hold the
// loading screen can store (Admin v2 E7 review, E7-C1). On a cold edge the plate starts to leave
// at cap + hold, which must outlast the measured cold image transform, so the cap follows the
// hold instead of being the constant 3 s it was when the hold was always 1 s.

/** The measured cold Cloudflare image transform of the logo (docs/hero-intro.md §3), in ms. */
const COLD_TRANSFORM_MS = 3583;

const HOLDS = stepValues(INTRO_HOLD);
const LONGEST_FADE = Math.max(...stepValues(INTRO_FADE));

describe('the intro gate’s cap follows the hold (E7-C1)', () => {
  it('every hold bucket starts to leave at 4 s at the latest on a cold edge, after the logo', () => {
    expect(HOLDS).toContain(INTRO_DEFAULTS.holdMs);
    for (const hold of HOLDS) {
      const cap = introHoldCap(hold);
      expect(cap, `the cap at ${hold} ms`).toBeGreaterThanOrEqual(0);
      expect(cap + hold, `cap + hold at ${hold} ms`).toBe(INTRO_LIFT_FLOOR_MS);
      expect(cap + hold, `cap + hold at ${hold} ms`).toBeGreaterThan(COLD_TRANSFORM_MS);
    }
    // The shortest hold is the one a constant 3 s cap failed: 3000 + 500 < 3583.
    expect(introHoldCap(INTRO_HOLD.min)).toBe(3500);
  });

  it('the worst case to content is 4 s plus the fade: 4.6 s at most', () => {
    for (const hold of HOLDS) {
      expect(introHoldCap(hold) + hold + LONGEST_FADE, `at ${hold} ms`).toBeLessThanOrEqual(4600);
    }
    // A constant 3 s cap let the longest hold and fade reach 5.1 s.
    expect(introHoldCap(INTRO_HOLD.max)).toBe(2500);
  });

  it('the default hold keeps the cap as built (the hero-intro e2e is tuned to it)', () => {
    expect(introHoldCap(INTRO_DEFAULTS.holdMs)).toBe(3000);
  });

  it('no hold (reduced motion zeroes it) keeps the cap as built; nonsense reads as no hold', () => {
    expect(introHoldCap(0)).toBe(INTRO_NO_HOLD_CAP_MS);
    expect(introHoldCap(Number.NaN)).toBe(INTRO_NO_HOLD_CAP_MS);
    expect(introHoldCap(-5)).toBe(INTRO_NO_HOLD_CAP_MS);
    expect(INTRO_NO_HOLD_CAP_MS).toBe(3000);
  });

  it('Hero.astro’s gate takes its cap from the hold it reads, never a constant', () => {
    const hero = readFileSync('src/components/sections/Hero.astro', 'utf8');
    expect(hero).toContain("import { introHoldCap } from '@/lib/client/introGate';");
    // The hold the gate already reads (the computed token, the bucket's value) feeds the cap.
    expect(hero).toMatch(
      /const holdMs = ms\(getComputedStyle\(document\.body\)\.getPropertyValue\('--bs-intro-hold'\)\) \|\| 0;/,
    );
    expect(hero).toMatch(/const HOLD_CAP_MS = introHoldCap\(holdMs\);/);
    expect(hero).toMatch(/setTimeout\(release, HOLD_CAP_MS\)/);
    expect(hero).not.toMatch(/HOLD_CAP_MS = \d/);
  });
});
