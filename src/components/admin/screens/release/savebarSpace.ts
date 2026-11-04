// The room a page keeps under the fixed savebar (Admin v2 R14a; releases.md §7, WCAG 2.2
// 2.4.11). The bar wraps onto two rows on most screens and three on a phone, so its height is
// measured, never assumed: admin.css reserves the measured height plus the bar's own inset
// (`--ad-savebar-gap`) for the end of the main column, the scroll padding that keeps a focused
// control clear of it, the sticky bulk bar and the toasts, all under the shown bar's gate.
// While a bulk bar is stuck above the shown bar, the scroll padding also keeps the bulk bar's
// own measured height (`--ad-bulkbar-h`, DataTable's BulkBar), so a focused row is clear of
// both. The measure is the shared reserveBoxHeight (src/lib/admin/client/boxHeight.ts).

import {
  reserveBoxHeight,
  type MeasuredBox,
  type ResizeObserverLike,
  type RootStyle,
} from '@/lib/admin/client/boxHeight';

/** The custom property admin.css reads (with `--ad-savebar` as its fallback before a measure). */
export const SAVEBAR_HEIGHT_PROPERTY = '--ad-savebar-h';

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
  return reserveBoxHeight(bar, root, Observer, SAVEBAR_HEIGHT_PROPERTY);
}
