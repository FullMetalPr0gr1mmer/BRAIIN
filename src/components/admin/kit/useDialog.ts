import { useEffect, useRef, type RefObject } from 'react';

// The behaviour Modal and Drawer share (Admin v2 F4b, ui.md §2.3): a native modal
// <dialog> opened with showModal(), which brings the focus trap, Escape, the top layer and
// focus returning to whatever opened it (the confirm.ts precedent). React owns `open`;
// the dialog reports every way it closes (Escape, the Close button, a light dismiss)
// through `onClose`, so the two never disagree.
//
// Initial focus (ui.md §2.3): an element marked `data-autofocus` (Cancel, for a
// destructive dialog), else the first field in the body, else the Close button.

const FOCUSABLE =
  'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function initialFocus(dialog: HTMLElement, bodySelector: string): HTMLElement | null {
  return (
    dialog.querySelector<HTMLElement>('[data-autofocus]') ??
    dialog.querySelector<HTMLElement>(`${bodySelector} :is(${FOCUSABLE})`) ??
    dialog.querySelector<HTMLElement>('[data-dialog-close]')
  );
}

export function useDialog(
  open: boolean,
  onClose: () => void,
  bodySelector: string,
): RefObject<HTMLDialogElement | null> {
  const ref = useRef<HTMLDialogElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      initialFocus(dialog, bodySelector)?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, bodySelector]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const onDialogClose = () => close.current();
    dialog.addEventListener('close', onDialogClose);
    return () => dialog.removeEventListener('close', onDialogClose);
  }, []);

  return ref;
}

/**
 * A click on the backdrop closes the dialog (light dismiss): the click lands on the
 * <dialog> itself only outside its content. Off for a form that would lose its input.
 */
export function backdropClose(event: { target: EventTarget; currentTarget: HTMLDialogElement }) {
  if (event.target === event.currentTarget) event.currentTarget.close();
}
