// The case-study image viewer (UI v2 PR11 — the mockup's `.lb`), on the page's one
// server-rendered <dialog data-lightbox> (src/components/case-study/Lightbox.astro).
//
// Every still is a real LINK to its full-size image (`a[data-lb]`), so without JS — or
// with a modifier-click, a middle click, "open in new tab" — it simply opens the image.
// This enhancement intercepts a plain click and shows the still in the dialog instead:
//
//   - showModal(): the page behind is inert (not focusable, not clickable, hidden from
//     assistive tech) — the mockup's div left the whole page reachable behind it;
//   - focus goes to Close on open, Tab / Shift+Tab wrap inside the dialog, and on close
//     focus returns to the still that opened it;
//   - Escape closes (the dialog's own `cancel`), a click on the backdrop closes;
//   - Previous / Next buttons, and the arrow keys — mirrored in RTL, where ArrowLeft is
//     "next" (the mockup swapped its BUTTONS' meaning in RTL instead, so "Previous" went
//     forwards);
//   - the counter ("03 / 09") is a polite live region, so a screen reader hears the move.
//
// Nothing is ever built from HTML: the one <img> is created with createElement and fed
// the link's own href and its thumbnail's alt text. A still's set is its group
// (`data-lb="bd"` breakdown, `"gal"` gallery), in document order.

/** i + delta, wrapping inside [0, n). */
export function stepIndex(i: number, delta: number, n: number): number {
  if (n <= 0) return 0;
  return (((i + delta) % n) + n) % n;
}

/** The step an arrow key means, or 0: ArrowRight is forward in LTR, backward in RTL. */
export function arrowDelta(key: string, rtl: boolean): number {
  if (key === 'ArrowRight') return rtl ? -1 : 1;
  if (key === 'ArrowLeft') return rtl ? 1 : -1;
  return 0;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "03 / 09" — the mockup's counter. */
export function counterLabel(i: number, n: number): string {
  return `${pad(i + 1)} / ${pad(n)}`;
}

/** A click the browser should keep: a modified or non-primary click opens the link as usual. */
export function isPlainClick(
  e: Pick<MouseEvent, 'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

export function initLightbox(): void {
  const dialog = document.querySelector<HTMLDialogElement>('dialog[data-lightbox]');
  if (!dialog || typeof dialog.showModal !== 'function') return;
  const stage = dialog.querySelector<HTMLElement>('[data-lb-stage]');
  const counter = dialog.querySelector<HTMLElement>('[data-lb-count]');
  const close = dialog.querySelector<HTMLButtonElement>('[data-lb-close]');
  const prev = dialog.querySelector<HTMLButtonElement>('[data-lb-prev]');
  const next = dialog.querySelector<HTMLButtonElement>('[data-lb-next]');
  if (!stage || !counter || !close || !prev || !next) return;

  const img = document.createElement('img');
  img.className = 'lightbox__img';
  img.decoding = 'async';
  stage.appendChild(img);

  let set: HTMLAnchorElement[] = [];
  let index = 0;
  let opener: HTMLAnchorElement | null = null;

  const show = (i: number) => {
    index = stepIndex(i, 0, set.length);
    const link = set[index];
    if (!link) return;
    img.src = link.href;
    img.alt = link.querySelector('img')?.alt ?? '';
    counter.textContent = counterLabel(index, set.length);
    const single = set.length < 2;
    prev.hidden = single;
    next.hidden = single;
  };

  document.addEventListener('click', (e) => {
    const link = (e.target as Element | null)?.closest<HTMLAnchorElement>('a[data-lb]');
    if (!link || !isPlainClick(e)) return;
    e.preventDefault();
    set = [...document.querySelectorAll<HTMLAnchorElement>('a[data-lb]')].filter(
      (a) => a.dataset.lb === link.dataset.lb,
    );
    opener = link;
    show(set.indexOf(link));
    dialog.showModal();
    close.focus();
  });

  close.addEventListener('click', () => dialog.close());
  prev.addEventListener('click', () => show(index - 1));
  next.addEventListener('click', () => show(index + 1));
  // The dialog fills the viewport; a click that lands on it directly (not on the image or
  // a control) is a click on the backdrop.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target === stage) dialog.close();
  });
  dialog.addEventListener('keydown', (e) => {
    const delta = arrowDelta(e.key, document.documentElement.dir === 'rtl');
    if (delta !== 0 && set.length > 1) {
      e.preventDefault();
      show(index + delta);
      return;
    }
    if (e.key !== 'Tab') return;
    // Keep Tab inside the dialog (showModal already makes the page inert; this stops focus
    // escaping to the browser chrome and back in between).
    const focusable = [close, prev, next].filter((b) => !b.hidden);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
  dialog.addEventListener('close', () => {
    img.removeAttribute('src');
    opener?.focus();
    opener = null;
  });
}
