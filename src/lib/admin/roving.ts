// Arrow-key movement inside a composite widget (Admin v2 F4b): the tablist (kit/Tabs.tsx)
// and the Sortable core use it, so arrows, Home and End, and the right-to-left mirror
// behave the same in both. The ARIA Authoring Practices' keyboard model: in a horizontal
// widget ArrowRight is "next" in a left-to-right page and "previous" in a right-to-left
// one; ArrowDown is "next" in a vertical one.

export interface RovingOptions {
  orientation?: 'horizontal' | 'vertical' | 'both';
  /** The widget's direction: in RTL the horizontal arrows swap. */
  rtl?: boolean;
  /** Past the last item comes the first (tabs); false stops at the ends (reordering). */
  wrap?: boolean;
}

/** The step an arrow key means here: +1, -1, or 0 when it is not this widget's key. */
export function arrowStep(
  key: string,
  { orientation = 'horizontal', rtl = false }: RovingOptions = {},
): -1 | 0 | 1 {
  const horizontal = orientation !== 'vertical';
  const vertical = orientation !== 'horizontal';
  if (horizontal && key === 'ArrowRight') return rtl ? -1 : 1;
  if (horizontal && key === 'ArrowLeft') return rtl ? 1 : -1;
  if (vertical && key === 'ArrowDown') return 1;
  if (vertical && key === 'ArrowUp') return -1;
  return 0;
}

/**
 * The index a key moves to from `current` among `count` items, or null when the key is
 * not one this widget handles (the caller then lets the browser have it).
 */
export function rovingIndex(
  key: string,
  current: number,
  count: number,
  options: RovingOptions = {},
): number | null {
  if (count <= 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const step = arrowStep(key, options);
  if (step === 0) return null;
  const next = current + step;
  if (options.wrap ?? true) return (next + count) % count;
  return Math.min(count - 1, Math.max(0, next));
}

/** The tab a `?tab=` value names when it is one of `ids`, else `fallback`. */
export function tabFromParam<T extends string>(
  value: string | null | undefined,
  ids: readonly T[],
  fallback: T,
): T {
  return ids.find((id) => id === value) ?? fallback;
}
