// Testimonials carousel, built to the WAI-ARIA APG carousel pattern (and so outside
// EXC-007: it has its own pause control). The design's visuals, a different motion model:
//
//   • auto-advances every 7 s only once 40% of it has been on screen, and stops whenever
//     it is off screen, the page is hidden, the pointer is over it, or keyboard focus is
//     inside it;
//   • a visible Pause/Play button beside the arrows — Play resumes even with focus inside;
//   • never auto-advances under prefers-reduced-motion (the button is not shown then);
//   • the slide region is aria-live="off" while rotating and "polite" otherwise, so an
//     automatic change is never announced over whatever the reader is doing;
//   • Arrow Left/Right move in the reading direction (RTL-aware).
//
// Without JS every quote is shown, stacked (the component's CSS default); `.is-enhanced`
// switches to one visible slide at a time.
//
// The timing decision is a pure function (carouselRunning) so it is unit-tested.

export const SLIDE_MS = 7000;

export interface CarouselFlags {
  started: boolean; // 40% seen at least once
  onScreen: boolean;
  pageVisible: boolean;
  reducedMotion: boolean;
  userPaused: boolean; // the Pause button
  hovered: boolean;
  focusInside: boolean;
  /** Play was pressed while focus was inside: focus no longer holds it. */
  focusOverridden: boolean;
}

export function carouselRunning(f: CarouselFlags): boolean {
  if (f.reducedMotion || !f.started || !f.onScreen || !f.pageVisible) return false;
  if (f.userPaused || f.hovered) return false;
  if (f.focusInside && !f.focusOverridden) return false;
  return true;
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
    focusInside: false,
    focusOverridden: false,
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
      toggle.setAttribute('aria-pressed', paused ? 'true' : 'false');
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
    // Play pressed with focus inside (on this very button): focus stops holding it.
    flags.focusOverridden = !flags.userPaused && flags.focusInside;
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
  root.addEventListener('focusin', () => {
    flags.focusInside = true;
    sync();
  });
  root.addEventListener('focusout', (e) => {
    if (root.contains(e.relatedTarget as Node | null)) return;
    flags.focusInside = false;
    flags.focusOverridden = false;
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
