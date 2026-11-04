// The room a page keeps under the fixed savebar (Admin v2 R14a; releases.md §7, WCAG 2.2
// 2.4.11). The bar wraps onto two rows on most screens and three on a phone, so its height is
// measured, never assumed: admin.css reserves the measured height plus the bar's own inset
// (`--ad-savebar-gap`) for the end of the main column, the scroll padding that keeps a focused
// control clear of it, the sticky bulk bar and the toasts, all under the shown bar's gate.
// Written through the CSSOM on the root, as AdminLayout does for the topbar's `--ad-top-h`
// (style-src allows the CSSOM; a style attribute in the markup would be refused). Pure of the
// DOM's globals, so a spec can drive it with a fake observer.

/** The custom property admin.css reads (with `--ad-savebar` as its fallback before a measure). */
export const SAVEBAR_HEIGHT_PROPERTY = '--ad-savebar-h';

/** What is measured: the bar's border box. */
export interface MeasuredBox {
  getBoundingClientRect(): { height: number };
}

/** The root's inline style (document.documentElement.style). */
export interface RootStyle {
  setProperty(name: string, value: string): void;
  removeProperty(name: string): unknown;
}

/** ResizeObserver's shape, as much of it as is used. */
export type ResizeObserverLike<T> = new (callback: () => void) => {
  observe(target: T): void;
  disconnect(): void;
};

/**
 * Writes the bar's height (whole pixels, rounded up so the room is never short) now and on
 * every resize; the returned stop disconnects and removes the property, so a hidden bar
 * reserves nothing.
 */
export function reserveSavebarSpace<T extends MeasuredBox>(
  bar: T,
  root: RootStyle,
  Observer: ResizeObserverLike<T>,
): () => void {
  const write = () =>
    root.setProperty(SAVEBAR_HEIGHT_PROPERTY, `${Math.ceil(bar.getBoundingClientRect().height)}px`);
  write();
  const observer = new Observer(write);
  observer.observe(bar);
  return () => {
    observer.disconnect();
    root.removeProperty(SAVEBAR_HEIGHT_PROPERTY);
  };
}
