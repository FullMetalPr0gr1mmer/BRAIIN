import { useEffect, useRef } from 'react';

// Showing a field that is on the form but out of sight (Admin v2 F5a): the Arabic half of
// a bilingual field while the editor shows English, an input in a collapsed repeater item.
// Both stay in the DOM (hidden), so an error or an "Arabic missing" gap can name them; a
// link to one asks for it to be shown first. The ErrorSummary and the "Next gap" button
// call revealField(id); each field that hides inputs listens and shows the one named.
// A DOM event rather than React context, so the kit's ErrorSummary needs no provider.

export const REVEAL_EVENT = 'admin:reveal-field';

/** Asks whichever field holds the element `id` to show it. */
export function revealField(id: string): void {
  if (typeof document === 'undefined') return;
  document.dispatchEvent(new CustomEvent(REVEAL_EVENT, { detail: { id } }));
}

/**
 * Reveals the element `id`, then focuses it and scrolls it into view on the next frame,
 * once the field has rendered it visible. False when there is no such element.
 */
export function revealAndFocus(id: string): boolean {
  if (typeof document === 'undefined') return false;
  const target = document.getElementById(id);
  if (!target) return false;
  openDetailsAround(target);
  revealField(id);
  requestAnimationFrame(() => {
    const element = document.getElementById(id);
    if (!element) return;
    element.focus();
    element.scrollIntoView({ block: 'center' });
  });
  return true;
}

/**
 * Opens every closed `<details>` the element sits in (Admin v2 U9: an editor's Advanced card),
 * innermost first, so it can be seen and focused. Returns how many it opened.
 */
export function openDetailsAround(element: Element): number {
  let opened = 0;
  let details = element.parentElement?.closest('details') ?? null;
  while (details) {
    if (!details.open) {
      details.open = true;
      opened += 1;
    }
    details = details.parentElement?.closest('details') ?? null;
  }
  return opened;
}

/** Calls `handler(id)` for every reveal request while the component is mounted. */
export function useRevealListener(handler: (id: string) => void): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const listener = (event: Event) => {
      const id = (event as CustomEvent<{ id?: unknown }>).detail?.id;
      if (typeof id === 'string') latest.current(id);
    };
    document.addEventListener(REVEAL_EVENT, listener);
    return () => document.removeEventListener(REVEAL_EVENT, listener);
  }, []);
}
