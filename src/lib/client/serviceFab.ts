// The service page's floating "Skip to inquiry" (Round 2 — service.html `.fab`). It
// follows the reader once most of the hero is behind them, steps aside when the inquiry
// form comes up, and STAYS aside below it: past the form there is nothing left to skip to
// (the mockup brought it back pointing up at the form — decision S4-2).
//
// Two IntersectionObservers, no scroll handler:
//   - a 1px mark placed at 60% of the hero's height. The hero is `position: sticky`, so it
//     never leaves the viewport and cannot be observed itself; the mark sits in the page's
//     normal flow instead (absolute in `main`, its `top` set through the CSSOM — CSP-safe —
//     and kept in step with the hero's height by a ResizeObserver);
//   - the inquiry section, with the root's bottom 15% cut off (the mockup's
//     `top < innerHeight * .85`): "reached" once its top is above that line, in view or
//     already scrolled past.
//
// While hidden the button is `inert`, `aria-hidden` and out of the tab order, and it sits
// off-screen behind a transform — never `display` toggling mid-layout. Without JS it never
// shows (the hero's own skip pill does the same job).

/** Share of the hero that must be scrolled past before the button shows. */
export const HERO_SHARE = 0.6;
/** The form counts as reached once its top is above this share of the viewport. */
export const FORM_LINE = 0.85;

/** What an observer entry tells us: is the target on screen, and is it above the viewport? */
export interface Seen {
  isIntersecting: boolean;
  top: number;
}

/** Past the mark: it is not on screen AND it went off the TOP (not still below the fold). */
export function pastMark(seen: Seen): boolean {
  return !seen.isIntersecting && seen.top < 0;
}

/** The form is reached: in the (bottom-trimmed) viewport, or already scrolled past it. */
export function formReached(seen: Seen): boolean {
  return seen.isIntersecting || seen.top < 0;
}

export function fabShown(pastHero: boolean, atForm: boolean): boolean {
  return pastHero && !atForm;
}

/** The mark's offset from the top of the page for a hero of this height (whole pixels). */
export function markOffset(heroHeight: number): number {
  return Math.max(0, Math.round(heroHeight * HERO_SHARE));
}

export function setFabShown(fab: HTMLElement, shown: boolean): void {
  fab.classList.toggle('is-shown', shown);
  fab.inert = !shown;
  if (shown) {
    fab.removeAttribute('aria-hidden');
    fab.removeAttribute('tabindex');
  } else {
    fab.setAttribute('aria-hidden', 'true');
    fab.setAttribute('tabindex', '-1');
  }
}

const seenOf = (e: IntersectionObserverEntry): Seen => ({
  isIntersecting: e.isIntersecting,
  top: e.boundingClientRect.top,
});

export function initServiceFab(root: Document = document): void {
  const fab = root.querySelector<HTMLElement>('.svc-fab');
  const mark = root.querySelector<HTMLElement>('.svc-fab__mark');
  const hero = root.querySelector<HTMLElement>('.hero');
  const form = root.getElementById('inquiry');
  if (!fab || !mark || !hero || !form || !('IntersectionObserver' in window)) return;

  const place = () => {
    mark.style.top = `${markOffset(hero.offsetHeight)}px`;
  };
  place();
  if ('ResizeObserver' in window) new ResizeObserver(place).observe(hero);

  let pastHero = false;
  let atForm = false;
  const apply = () => setFabShown(fab, fabShown(pastHero, atForm));

  new IntersectionObserver((entries) => {
    const last = entries[entries.length - 1];
    if (!last) return;
    pastHero = pastMark(seenOf(last));
    apply();
  }).observe(mark);

  new IntersectionObserver(
    (entries) => {
      const last = entries[entries.length - 1];
      if (!last) return;
      atForm = formReached(seenOf(last));
      apply();
    },
    { rootMargin: `0px 0px -${Math.round((1 - FORM_LINE) * 100)}% 0px` },
  ).observe(form);
}
