import { useId, type ReactNode } from 'react';
import Icon from './Icon';
import { backdropClose, useDialog } from './useDialog';

// A drawer (Admin v2 F4b; designed in AV-04, which F3 handed to the kit, the prototype's
// .drw): a native modal <dialog> that opens from the inline end, 560px (820px `wide`),
// the full width under 600px, with a fixed header and footer and a scrolling body. The
// same behaviour as Modal (useDialog): Escape, focus trap, focus back to the opener.

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  footer?: ReactNode;
  size?: 'wide' | undefined;
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
      className="admin-dialog drw"
      data-size={size}
      aria-labelledby={titleId}
      onClick={dismissible ? backdropClose : undefined}
    >
      <div className="drw__h">
        <h2 id={titleId}>{title}</h2>
        <button
          type="button"
          className="icon-btn"
          data-dialog-close=""
          aria-label="Close"
          onClick={() => ref.current?.close()}
        >
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="drw__b">{children}</div>
      {footer && <div className="drw__f">{footer}</div>}
    </dialog>
  );
}
