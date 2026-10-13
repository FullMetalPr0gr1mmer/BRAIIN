// Where focus goes when one of the shell's modal drawers closes (Admin v2 F8; WCAG 2.4.3
// focus order, 2.4.11 focus not obscured).
//
// A native modal <dialog> gives focus back to whatever was focused when it opened, and on a
// wide screen that is enough: the bell or the account chip takes it back. Below 900px the
// chip sits in the sidebar popover, and showModal() closes every popover the dialog is not
// inside, so when the drawer closes the chip is not rendered. The browser's attempt to focus
// it does nothing, focus stays on a control of the closed dialog, and Chromium drops it to
// <body> only a task later, after `close` has fired. So `close` cannot wait to see <body>:
// it asks whether focus is somewhere a person can see, and if not, moves it to the trigger
// when that is still on screen, else to the fallback (the Menu button, which reopens the
// sidebar). When neither is rendered it leaves focus alone rather than aim at a hidden one.
//
// The decision is kept apart from the DOM (`contains` and `shown` are passed in) so it is
// unit-tested without a browser; personal.e2e.ts drives it in one.

export interface FocusReturnState<E, C extends E> {
  /** `document.activeElement` when the dialog's `close` event fires. */
  active: E | null;
  /** The document's body: focus left there is focus lost. */
  body: E;
  /** The dialog that closed. Nothing inside it is rendered any more. */
  dialog: E;
  /** The trigger the drawer was opened from, if a click opened it. */
  opener: C | null;
  /** Where focus goes when the trigger is not on screen. */
  fallback: C | null;
  contains: (container: E, element: E) => boolean;
  shown: (element: E) => boolean;
}

/** The element to focus after a drawer closed, or null when focus is already fine. */
export function focusReturnTarget<E, C extends E>(state: FocusReturnState<E, C>): C | null {
  const { active } = state;
  const settled =
    active !== null &&
    active !== state.body &&
    !state.contains(state.dialog, active) &&
    state.shown(active);
  if (settled) return null;
  if (state.opener !== null && state.shown(state.opener)) return state.opener;
  if (state.fallback !== null && state.shown(state.fallback)) return state.fallback;
  return null;
}

/**
 * In the browser: the element is in the document and has a box. A closed popover or dialog
 * is `display: none`, so nothing inside one has a client rect.
 */
export function isRendered(element: Element): boolean {
  return element.isConnected && element.getClientRects().length > 0;
}
