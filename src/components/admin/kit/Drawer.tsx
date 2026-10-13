import { useId, type ReactNode } from 'react';
import Icon from './Icon';
import { backdropClose, useDialog } from './useDialog';

// A drawer (Admin v2 F4b; designed in AV-04, which F3 handed to the kit, the prototype's
// .drw): a native modal <dialog> that opens from the inline end, 560px (820px `wide`),
// the full width on a phone, with a fixed header and footer and a scrolling body. F8's
// shell drawers (screens/chrome/ChromeDrawer.tsx) drew the anatomy and admin.css first;
// this is the same markup (the panel fills the dialog, so a click on the dialog itself is
// a click on the scrim) with the kit's behaviour (useDialog): Escape, the focus trap,
// initial focus in the body, and focus back to the opener.

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  footer?: ReactNode;
  size?: 'wide' | undefined;
  /** A click on the scrim closes it (the default); off for a form with input. */
  dismissible?: boolean;
  children: ReactNode;
}

export default function Drawer({
  open,
  onClose,
  title,
  footer,
  size,
  dismissible = true,
  children,
}: DrawerProps) {
  const ref = useDialog(open, onClose, '.drw__b');
  const titleId = useId();
  return (
    <dialog
      ref={ref}
      className="drw"
      data-size={size}
      aria-labelledby={titleId}
      onClick={dismissible ? backdropClose : undefined}
    >
      <div className="drw__panel">
        <div className="drw__h">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="btn--icon"
            data-variant="ghost"
            data-dialog-close=""
            aria-label="Close"
            onClick={() => ref.current?.close()}
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
