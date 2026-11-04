// How long the home intro's plate may wait for its logo (Hero.astro's gate, docs/hero-intro.md
// §3). The logo is a runtime image transform: about 0.7 s warm, measured 3.58 s on a cold edge.
// The gate pauses the plate while it HOLDS and releases on the logo's load, or at the cap at
// the latest, after which the rest of the hold still runs. So on a cold edge the plate starts to
// leave at cap + hold (the module's own start cancels out), and that sum must outlast the cold
// transform, or the plate lifts before the logo exists.
//
// As built the hold was always 1 s and the cap a constant 3 s: 4 s. Since the loading screen's
// timing (Admin v2 E7) the hold is a bucket, 500 to 1500 ms, so the cap is derived from it and
// the sum stays 4 s for every bucket (E7 review, E7-C1): a 500 ms hold waits 3.5 s, the 1 s
// default still 3 s, a 1.5 s hold 2.5 s. The worst case to content is then 4 s plus the fade
// (300 to 600 ms): 4.6 s at most (4.45 s as built; a constant 3 s cap would have let a 1.5 s
// hold and a 600 ms fade reach 5.1 s). Pure and tiny, so the public hero script carries it at
// no cost, and tests/lib/introGate.spec.ts holds it against every bucket.

/** When, at the latest, the plate starts to leave on a cold edge (cap + hold), in ms. */
export const INTRO_LIFT_FLOOR_MS = 4000;

/** The cap when there is no hold (reduced motion zeroes it): unchanged from the intro as built. */
export const INTRO_NO_HOLD_CAP_MS = 3000;

/** The gate's cap for a plate holding `holdMs` (the computed `--bs-intro-hold`), in ms. */
export function introHoldCap(holdMs: number): number {
  if (!(holdMs > 0)) return INTRO_NO_HOLD_CAP_MS;
  return Math.max(0, INTRO_LIFT_FLOOR_MS - holdMs);
}
