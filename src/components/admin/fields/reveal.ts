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
  if (typeof document === 'undefined' || !document.getElementById(id)) return false;
  revealField(id);
  requestAnimationFrame(() => {
    const element = document.getElementById(id);
    if (!element) return;
    element.focus();
    element.scrollIntoView({ block: 'center' });
  });
  return true;
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
