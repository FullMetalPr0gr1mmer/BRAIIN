import { useEffect, useRef, type ReactNode, type RefObject, type MouseEvent } from 'react';
import Icon from '@/components/admin/kit/Icon';
import { focusReturnTarget, isRendered } from '@/lib/admin/focusReturn';

// The shell's side drawers (Admin v2 F8): the prototype's .drw, on a native modal <dialog>
// (ui.md §2.3), which brings the focus trap, Escape, the top layer and focus return to
// the trigger. It opens from the inline end, full width on a phone.
//
// The general Drawer of the component kit is F4b's, built in parallel; this one is private
// to the shell's two drawers (bell and account) and uses the same class names, so the
// kit's can replace it without touching admin.css.

export interface ChromeDrawerProps {
  dialogRef: RefObject<HTMLDialogElement | null>;
  /** The trigger that opened the drawer (useOpenOn's), for focus return. */
  openerRef: RefObject<HTMLElement | null>;
  /** The id of the drawer's heading, which names the dialog. */
  titleId: string;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}

export default function ChromeDrawer({
  dialogRef,
  openerRef,
  titleId,
  title,
  children,
  footer,
}: ChromeDrawerProps) {
  // A click on the dialog itself is a click on the scrim around the panel: it closes.
  function onClick(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === dialogRef.current) dialogRef.current?.close();
  }

  // The dialog gives focus back to its trigger itself, except where the trigger is gone:
  // below 900px the account chip sits in the sidebar popover, which showModal() closed, so
  // focus is stranded on the closed dialog (and drops to <body> a task after `close`).
  // Focus then goes to the trigger if it is on screen, else to the Menu button that opens
  // the sidebar (src/lib/admin/focusReturn.ts).
  function onClose() {
    const dialog = dialogRef.current;
    if (!dialog) return;
    focusReturnTarget<Element, HTMLElement>({
      active: document.activeElement,
      body: document.body,
      dialog,
      opener: openerRef.current,
      fallback: document.querySelector<HTMLElement>('[popovertarget="admin-side"]'),
      contains: (container, element) => container.contains(element),
      shown: isRendered,
    })?.focus();
  }

  return (
    <dialog
      ref={dialogRef}
      className="drw"
      aria-labelledby={titleId}
      onClick={onClick}
      onClose={onClose}
    >
      <div className="drw__panel">
        <div className="drw__h">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="btn--icon"
            data-variant="ghost"
            aria-label="Close"
            onClick={() => dialogRef.current?.close()}
          >
            <Icon name="x" />
          </button>
        </div>
        <div className="drw__b">{children}</div>
        {footer && <div className="drw__f">{footer}</div>}
      </div>
    </dialog>
  );
}

/**
 * Opens a drawer from its trigger: any `[data-open="<name>"]` in the page. The trigger is
 * a real link (the bell to /admin/notifications, the account chip to /admin/account), so
 * without JS it still goes somewhere; with JS a plain click opens the drawer instead, and a
 * click with a modifier (a new tab) is left to the browser. `open` is handed the trigger
 * (the help drawer reads which guide a page head's "Guide" names, U16). Returns the trigger
 * last used, for ChromeDrawer's focus return.
 */
export function useOpenOn(
  name: string,
  open: (trigger: HTMLElement) => void,
): RefObject<HTMLElement | null> {
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onClick = (event: globalThis.MouseEvent) => {
      const trigger = (event.target as Element | null)?.closest<HTMLElement>(
        `[data-open="${name}"]`,
      );
      if (!trigger || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
        return;
      }
      event.preventDefault();
      opener.current = trigger;
      open(trigger);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [name, open]);
  return opener;
}
