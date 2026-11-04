// A box's measured height, kept on the root as a custom property for admin.css to reserve room
// with (Admin v2 R14a; WCAG 2.2 2.4.11). The fixed savebar (`--ad-savebar-h`,
// src/components/admin/screens/release/savebarSpace.ts) and the sticky bulk bar
// (`--ad-bulkbar-h`, DataTable's BulkBar) wrap onto more rows on a narrow screen, so their
// heights are measured, never assumed. Written through the CSSOM on the root, as AdminLayout
// does for the topbar's `--ad-top-h` (style-src allows the CSSOM; a style attribute in the
// markup would be refused). Pure of the DOM's globals, so a spec can drive it with a fake
// observer.

/** What is measured: the box's border box. */
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
 * Writes the box's height to `property` (whole pixels, rounded up so the room is never short)
 * now and on every resize; the returned stop disconnects and removes the property, so a box
 * that is gone reserves nothing.
 */
export function reserveBoxHeight<T extends MeasuredBox>(
  box: T,
  root: RootStyle,
  Observer: ResizeObserverLike<T>,
  property: string,
): () => void {
  const write = () =>
    root.setProperty(property, `${Math.ceil(box.getBoundingClientRect().height)}px`);
  write();
  const observer = new Observer(write);
  observer.observe(box);
  return () => {
    observer.disconnect();
    root.removeProperty(property);
  };
}
