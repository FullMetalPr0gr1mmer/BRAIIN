import { useId, type ReactNode } from 'react';
import Icon from './Icon';
import { useBackdropDismiss, useDialog } from './useDialog';

// A modal (Admin v2 F4b; designed in AV-04, which F3 handed to the kit, the prototype's
// .mdl): a native modal <dialog> with a title (h2, 18/800), an optional line under it, a
// Close button, the body, and a footer whose primary action comes last. Focus starts on
// `data-autofocus` (Cancel in a destructive dialog), else the first field (useDialog).

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  sub?: string | undefined;
  footer?: ReactNode;
  size?: 'lg' | undefined;
  /**
   * A press on the backdrop closes it (the default; useDialog's backdropDismiss: a press
   * that starts inside never does). Off for a form, so a stray press keeps its input.
   */
  dismissible?: boolean;
  children: ReactNode;
}

export default function Modal({
  open,
  onClose,
  title,
  sub,
  footer,
  size,
  dismissible = true,
  children,
}: ModalProps) {
  const ref = useDialog(open, onClose, '.mdl__b');
  const dismiss = useBackdropDismiss(dismissible);
  const titleId = useId();
  const subId = useId();
  return (
    <dialog
      ref={ref}
      className="admin-dialog mdl"
      data-size={size}
      aria-labelledby={titleId}
      aria-describedby={sub ? subId : undefined}
      {...dismiss}
    >
      <div className="mdl__h">
        <div>
          <h2 id={titleId}>{title}</h2>
          {sub && (
            <p id={subId} className="mdl__sub">
              {sub}
            </p>
          )}
        </div>
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
      <div className="mdl__b">{children}</div>
      {footer && <div className="mdl__f">{footer}</div>}
    </dialog>
  );
}
