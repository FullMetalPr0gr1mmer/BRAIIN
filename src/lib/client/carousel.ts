// Testimonials carousel, built to the WAI-ARIA APG carousel pattern (and so outside
// EXC-007: it has its own pause control). The design's visuals, a different motion model:
//
//   • auto-advances every 7 s only once 40% of it has been on screen, and pauses whenever
//     it is off screen, the page is hidden or the pointer is over it;
//   • keyboard focus arriving from outside STOPS it (APG): it does not resume when focus
//     leaves — only the Play button restarts it, and it does so even with focus inside;
//   • a visible Pause/Play button beside the arrows: a plain button whose label changes
//     (the APG carousel's rotation control), so no aria-pressed;
//   • never auto-advances under prefers-reduced-motion (the button is not shown then);
//   • the slide region is aria-live="off" while rotating and "polite" otherwise, so an
//     automatic change is never announced over whatever the reader is doing;
//   • Arrow Left/Right move in the reading direction (RTL-aware).
//
// Without JS every quote is shown, stacked (the component's CSS default); `.is-enhanced`
// switches to one visible slide at a time.
//
// The timing decisions are pure functions (carouselRunning, focusEntryStops) so they are
// unit-tested.

export const SLIDE_MS = 7000;

export interface CarouselFlags {
  started: boolean; // 40% seen at least once
  onScreen: boolean;
  pageVisible: boolean;
  reducedMotion: boolean;
  userPaused: boolean; // the Pause button, or keyboard focus arriving — cleared only by Play
  hovered: boolean;
}

export function carouselRunning(f: CarouselFlags): boolean {
  if (f.reducedMotion || !f.started || !f.onScreen || !f.pageVisible) return false;
  if (f.userPaused || f.hovered) return false;
  return true;
}

/**
 * Whether a focusin stops rotation. Only KEYBOARD focus (:focus-visible) arriving from
 * outside does: a mouse click on Pause would otherwise stop it on focus and restart it on
 * the click, and a click on an arrow would stop it for good. Focus moving between the
 * controls changes nothing, and under reduced motion there is nothing to stop.
 */
export function focusEntryStops(e: {
  entering: boolean;
  keyboard: boolean;
  reducedMotion: boolean;
}): boolean {
  return e.entering && e.keyboard && !e.reducedMotion;
}

/** The next index, wrapping. */
export function step(index: number, by: number, count: number): number {
  return (((index + by) % count) + count) % count;
}

export function initCarousel(root: HTMLElement): void {
  const slides = [...root.querySelectorAll<HTMLElement>('[data-slide]')];
  if (slides.length < 2) return;
  const stage = root.querySelector<HTMLElement>('[data-stage]');
  const bar = root.querySelector<HTMLElement>('[data-bar]');
  const counter = root.querySelector<HTMLElement>('[data-counter]');
  const prev = root.querySelector<HTMLButtonElement>('[data-prev]');
  const next = root.querySelector<HTMLButtonElement>('[data-next]');
  const toggle = root.querySelector<HTMLButtonElement>('[data-toggle]');
  const labels = {
    pause: toggle?.dataset.labelPause ?? 'Pause',
    play: toggle?.dataset.labelPlay ?? 'Play',
  };

  const flags: CarouselFlags = {
    started: false,
    onScreen: false,
    pageVisible: !document.hidden,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    userPaused: false,
    hovered: false,
  };
  let index = 0;

  root.classList.add('is-enhanced');
  // The controls are meaningless without script, so the server renders them hidden.
  root.querySelector('[data-controls]')?.removeAttribute('hidden');
  if (toggle && !flags.reducedMotion) toggle.removeAttribute('hidden');
  bar?.style.setProperty('--carousel-ms', `${SLIDE_MS}ms`);

  const pad = (n: number) => String(n).padStart(2, '0');

  function render(): void {
    slides.forEach((slide, i) => {
      const on = i === index;
      slide.classList.toggle('is-active', on);
      slide.toggleAttribute('inert', !on);
      slide.setAttribute('aria-hidden', on ? 'false' : 'true');
    });
    if (counter) {
      const b = document.createElement('b');
      b.textContent = pad(index + 1);
      counter.replaceChildren(b, ` / ${pad(slides.length)}`);
    }
  }

  function restartBar(): void {
    if (!bar) return;
    bar.classList.remove('is-running');
    void bar.offsetWidth; // reflow so the fill animation restarts from zero
    bar.classList.add('is-running');
  }

  function sync(): void {
    const running = carouselRunning(flags);
    root.classList.toggle('is-paused', !running);
    stage?.setAttribute('aria-live', running ? 'off' : 'polite');
    if (toggle) {
      const paused = flags.userPaused;
      toggle.setAttribute('aria-label', paused ? labels.play : labels.pause);
      toggle.classList.toggle('is-play', paused);
    }
  }

  function go(to: number): void {
    index = step(index, to - index, slides.length);
    render();
    restartBar();
    sync();
  }

  bar?.addEventListener('animationend', () => {
    if (carouselRunning(flags)) go(index + 1);
  });
  prev?.addEventListener('click', () => go(index - 1));
  next?.addEventListener('click', () => go(index + 1));
  toggle?.addEventListener('click', () => {
    flags.userPaused = !flags.userPaused;
    sync();
  });
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const rtl = document.documentElement.dir === 'rtl';
    const forward = (e.key === 'ArrowRight') !== rtl;
    go(index + (forward ? 1 : -1));
  });
  root.addEventListener('pointerenter', () => {
    flags.hovered = true;
    sync();
  });
  root.addEventListener('pointerleave', () => {
    flags.hovered = false;
    sync();
  });
  root.addEventListener('focusin', (e) => {
    const stops = focusEntryStops({
      entering: !root.contains(e.relatedTarget as Node | null),
      keyboard: e.target instanceof Element && e.target.matches(':focus-visible'),
      reducedMotion: flags.reducedMotion,
    });
    if (!stops) return;
    flags.userPaused = true;
    sync();
  });
  document.addEventListener('visibilitychange', () => {
    flags.pageVisible = !document.hidden;
    sync();
  });
  new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        flags.onScreen = e.intersectionRatio > 0;
        if (e.intersectionRatio >= 0.4 && !flags.started) {
          flags.started = true;
          restartBar();
        }
      }
      sync();
    },
    { threshold: [0, 0.4] },
  ).observe(root);

  render();
  sync();
}

export function initCarousels(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-carousel]')) initCarousel(el);
}
