// Stat count-up (StatBand). An ENHANCEMENT: the server renders every number at its final
// value, so without JS, for a crawler, under reduced motion — and for a number already on
// screen when the page loads — the value is simply there. Only a number that is still
// off-screen is reset to 0 at startup and counts up (1500 ms, ease-out cubic) when 60% of
// it comes into view, once.
//
//   <span class="sr-only">250+</span>
//   <span aria-hidden="true"><span data-count-to="250">250</span><i>+</i></span>
//
// Only the aria-hidden copy animates: assistive tech reads ahead of the viewport, so the
// value it reads is the fixed .sr-only one (StatBand.astro). Printing the page puts any
// counter still waiting at 0 back to its final value.

export const COUNT_DURATION_MS = 1500;

/** ease-out cubic, as the design's count-up. */
export function easeOutCubic(k: number): number {
  const t = Math.min(1, Math.max(0, k));
  return 1 - Math.pow(1 - t, 3);
}

/** The integer shown `elapsed` ms into a count to `to`. */
export function countValue(to: number, elapsed: number, duration = COUNT_DURATION_MS): number {
  return Math.round(to * easeOutCubic(elapsed / duration));
}

function inViewport(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
}

function run(el: HTMLElement, to: number): void {
  const t0 = performance.now();
  const step = (now: number) => {
    const elapsed = now - t0;
    el.textContent = String(countValue(to, elapsed));
    if (elapsed < COUNT_DURATION_MS) requestAnimationFrame(step);
    else el.textContent = String(to);
  };
  requestAnimationFrame(step);
}

export function initCountUp(root: ParentNode = document): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!('IntersectionObserver' in window)) return;
  const pending = new Set<HTMLElement>(); // reset to 0, not counted yet
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        const el = e.target as HTMLElement;
        pending.delete(el);
        run(el, Number(el.dataset.countTo));
      }
    },
    { threshold: 0.6 },
  );
  for (const el of root.querySelectorAll<HTMLElement>('[data-count-to]')) {
    const to = Number(el.dataset.countTo);
    if (!Number.isFinite(to) || to <= 0) continue;
    if (inViewport(el)) continue; // already seen at its final value — never flash it to 0
    el.textContent = '0';
    pending.add(el);
    io.observe(el);
  }
  if (pending.size === 0) return;
  addEventListener(
    'beforeprint',
    () => {
      for (const el of pending) {
        io.unobserve(el);
        el.textContent = el.dataset.countTo ?? '';
      }
      pending.clear();
    },
    { once: true },
  );
}
