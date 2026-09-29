// The sitewide motion state (WCAG 2.2.2 Pause, Stop, Hide — Round 3 R3-7). No control ships
// today: the header button was built and removed on 2026-09-29 at the owner's decision
// (mockup parity; EXC-007 stays open), so this state has no writer until it returns.
//
// One state, `body.motion-paused`, read by everything that moves on its own: the CSS
// loops (the clients marquee, the hero scroll cue, the banner caption's pulse — each has
// an `animation-play-state: paused` rule under the class), the background loops
// (lazyVideo.ts), the in-content clips (clips.ts) and the testimonials carousel
// (carousel.ts). A header button (SiteHeader.astro; removed) was its only writer.
//
// Changes are broadcast as a `motion-updated` CustomEvent on `document` — the
// `consent-updated` pattern — so each subsystem subscribes on its own and this module
// imports nothing. That matters: the header is on every route, and it must never pull
// the video code along with it.
//
// The choice is remembered per tab in sessionStorage (`bs_motion`, the key the removed
// hero control used, commit 03b4987) so it survives navigation. It is a functional
// setting under the cookie policy (src/lib/legal/content.ts: "strictly necessary; always
// on"), so no consent gate applies; storage is wrapped in try/catch because a private
// window or blocked site data can throw, and the switch must keep working for the page.

export const MOTION_KEY = 'bs_motion';
export const MOTION_EVENT = 'motion-updated';
export const MOTION_CLASS = 'motion-paused';

export type MotionState = 'paused' | 'playing';

/** The stored value → paused? Anything but the literal 'paused' means playing. */
export function parseStoredMotion(raw: string | null | undefined): boolean {
  return raw === 'paused';
}

/** The value to store for a state. */
export function serializeMotion(paused: boolean): MotionState {
  return paused ? 'paused' : 'playing';
}

/** The remembered choice for this tab (false when nothing is stored or storage throws). */
export function readStoredMotion(): boolean {
  try {
    return parseStoredMotion(sessionStorage.getItem(MOTION_KEY));
  } catch {
    return false;
  }
}

/** Remembers the choice for this tab; silently a no-op when storage is unavailable. */
export function writeStoredMotion(paused: boolean): void {
  try {
    sessionStorage.setItem(MOTION_KEY, serializeMotion(paused));
  } catch {
    // per-page switch only
  }
}

export function isMotionPaused(): boolean {
  return document.body.classList.contains(MOTION_CLASS);
}

/**
 * Sets the sitewide state and tells every subscriber. Idempotent: setting the state it
 * already has dispatches nothing, so a restored "paused" on load never double-fires.
 */
export function setMotionPaused(paused: boolean): void {
  if (isMotionPaused() === paused) return;
  document.body.classList.toggle(MOTION_CLASS, paused);
  document.dispatchEvent(new CustomEvent<boolean>(MOTION_EVENT, { detail: paused }));
}

/** Subscribes to state changes; returns the unsubscribe. */
export function onMotionChange(cb: (paused: boolean) => void): () => void {
  const handler = () => cb(isMotionPaused());
  document.addEventListener(MOTION_EVENT, handler);
  return () => document.removeEventListener(MOTION_EVENT, handler);
}
