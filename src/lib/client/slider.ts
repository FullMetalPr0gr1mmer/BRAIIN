// The About leadership slider (LeadershipSlider.astro — the mockup's `.lt__track`).
//
// Without JS it is a native horizontal scroller with scroll-snap: every card is in the
// HTML and reachable by scrolling, swiping or tabbing through the LinkedIn links. This
// module adds the design's chrome on top:
//
//   • Previous / Next move one card (card width + column gap), in the reading direction —
//     RTL `scrollLeft` runs negative, so positions are taken as Math.abs(scrollLeft) and
//     the step is signed by the document direction;
//   • the chrome shows only when the cards overflow (the mockup's `ltNav.hidden = max < 4`);
//   • at either end the button is aria-disabled, not `disabled` — a disabled button drops
//     keyboard focus to <body> the moment it is reached;
//   • the "01 / 06" counter and the progress bar follow the first visible card. The bar
//     moves by TRANSFORM only (translateX + scaleX through two custom properties set via
//     the CSSOM, which the nonce CSP permits) — the mockup animated margin and width;
//   • ArrowLeft / ArrowRight on the focused track step one card, RTL-aware;
//   • under reduced motion every scroll is instant (`behavior: 'auto'`).
//
// The geometry is a pure function (sliderState) so it is unit-tested.

export interface SliderGeometry {
  /** Math.abs(track.scrollLeft). */
  pos: number;
  scrollWidth: number;
  clientWidth: number;
  /** One card + one gap, in px (0 when there are no cards). */
  step: number;
  count: number;
}

export interface SliderState {
  overflow: boolean;
  atStart: boolean;
  atEnd: boolean;
  /** 0-based index of the first visible card. */
  first: number;
  perView: number;
  /** "01" — the first visible card, zero-padded. */
  current: string;
  /** "06" — the total, zero-padded. */
  total: string;
  /** Progress bar: offset and length as fractions of the bar. */
  barOffset: number;
  barScale: number;
}

/** The design's slack at both ends (sub-pixel scroll positions). */
const EDGE = 4;

export const pad2 = (n: number): string => String(n).padStart(2, '0');

export function sliderState(g: SliderGeometry): SliderState {
  const count = Math.max(0, g.count);
  const max = Math.max(0, g.scrollWidth - g.clientWidth);
  const pos = Math.min(Math.max(0, g.pos), max);
  const step = g.step > 0 ? g.step : 1;
  const perView =
    count === 0 ? 0 : Math.min(count, Math.max(1, Math.round((g.clientWidth + 1) / step)));
  const first = count === 0 ? 0 : Math.max(0, Math.min(count - perView, Math.round(pos / step)));
  return {
    overflow: max >= EDGE,
    atStart: pos < EDGE,
    atEnd: pos > max - EDGE,
    first,
    perView,
    current: pad2(count === 0 ? 0 : first + 1),
    total: pad2(count),
    barOffset: count === 0 ? 0 : first / count,
    barScale: count === 0 ? 1 : perView / count,
  };
}

/** Which way a key moves the slider: +1 next, -1 previous, 0 not a slider key. */
export function keyStep(key: string, rtl: boolean): -1 | 0 | 1 {
  if (key === 'ArrowRight') return rtl ? -1 : 1;
  if (key === 'ArrowLeft') return rtl ? 1 : -1;
  return 0;
}

export function initSlider(root: HTMLElement): void {
  const track = root.querySelector<HTMLElement>('[data-slider-track]');
  const list = track?.querySelector<HTMLElement>('ul');
  const nav = root.querySelector<HTMLElement>('[data-slider-nav]');
  const prev = root.querySelector<HTMLButtonElement>('[data-slider-prev]');
  const next = root.querySelector<HTMLButtonElement>('[data-slider-next]');
  const current = root.querySelector<HTMLElement>('[data-slider-current]');
  const total = root.querySelector<HTMLElement>('[data-slider-total]');
  const bar = root.querySelector<HTMLElement>('[data-slider-bar]');
  if (!track || !list || !nav || !prev || !next) return;

  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const rtl = () => getComputedStyle(root).direction === 'rtl';

  const stepPx = (): number => {
    const card = list.firstElementChild;
    if (!card) return 0;
    const gap = parseFloat(getComputedStyle(list).columnGap) || 0;
    return card.getBoundingClientRect().width + gap;
  };

  let frame = 0;
  const update = () => {
    frame = 0;
    const s = sliderState({
      pos: Math.abs(track.scrollLeft),
      scrollWidth: track.scrollWidth,
      clientWidth: track.clientWidth,
      step: stepPx(),
      count: list.children.length,
    });
    nav.hidden = !s.overflow;
    prev.setAttribute('aria-disabled', String(s.atStart));
    next.setAttribute('aria-disabled', String(s.atEnd));
    if (current) current.textContent = s.current;
    if (total) total.textContent = s.total;
    if (bar) {
      bar.style.setProperty('--sl-x', String(s.barOffset));
      bar.style.setProperty('--sl-s', String(s.barScale));
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };

  const move = (by: -1 | 1) => {
    const s = sliderState({
      pos: Math.abs(track.scrollLeft),
      scrollWidth: track.scrollWidth,
      clientWidth: track.clientWidth,
      step: stepPx(),
      count: list.children.length,
    });
    if ((by < 0 && s.atStart) || (by > 0 && s.atEnd)) return;
    track.scrollBy({
      left: by * stepPx() * (rtl() ? -1 : 1),
      behavior: reduced.matches ? 'auto' : 'smooth',
    });
  };

  prev.addEventListener('click', () => move(-1));
  next.addEventListener('click', () => move(1));
  track.addEventListener('keydown', (e) => {
    const by = keyStep(e.key, rtl());
    if (by === 0) return;
    e.preventDefault();
    move(by);
  });
  track.addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', schedule);
  root.classList.add('is-enhanced');
  update();
}

export function initSliders(): void {
  for (const root of document.querySelectorAll<HTMLElement>('[data-slider]')) initSlider(root);
}
