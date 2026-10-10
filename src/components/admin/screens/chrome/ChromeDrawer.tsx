import { useEffect, type ReactNode, type RefObject, type MouseEvent } from 'react';
import Icon from '@/components/admin/kit/Icon';

// The shell's side drawers (Admin v2 F8): the prototype's .drw, on a native modal <dialog>
// (ui.md §2.3), which brings the focus trap, Escape, the top layer and focus return to
// the trigger with no code of ours. It opens from the inline end, full width on a phone.
//
// The general Drawer of the component kit is F4b's, built in parallel; this one is private
// to the shell's two drawers (bell and account) and uses the same class names, so the
// kit's can replace it without touching admin.css.

export interface ChromeDrawerProps {
  dialogRef: RefObject<HTMLDialogElement | null>;
  /** The id of the drawer's heading, which names the dialog. */
  titleId: string;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}

export default function ChromeDrawer({
  dialogRef,
  titleId,
  title,
  children,
  footer,
}: ChromeDrawerProps) {
  // A click on the dialog itself is a click on the scrim around the panel: it closes.
  function onClick(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === dialogRef.current) dialogRef.current?.close();
  }

  return (
    <dialog ref={dialogRef} className="drw" aria-labelledby={titleId} onClick={onClick}>
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
 * click with a modifier (a new tab) is left to the browser.
 */
export function useOpenOn(name: string, open: () => void): void {
  useEffect(() => {
    const onClick = (event: globalThis.MouseEvent) => {
      const trigger = (event.target as Element | null)?.closest(`[data-open="${name}"]`);
      if (!trigger || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
        return;
      }
      event.preventDefault();
      open();
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [name, open]);
}
