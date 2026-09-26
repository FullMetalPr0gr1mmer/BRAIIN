// A confirm dialog on the native <dialog> element, replacing window.confirm().
//
// Why replace it at all: window.confirm renders browser chrome that ignores the admin
// theme, blocks the main thread, and can be suppressed wholesale by the browser after
// repeated use ("prevent this page from creating additional dialogs") — at which point
// every destructive action silently proceeds or silently no-ops depending on the
// browser. A real <dialog> is also the phase-1 primitive that phase 2's bulk actions
// will reuse.
//
// Why NATIVE <dialog> rather than a styled div: showModal() gives the focus trap,
// Escape handling, top-layer stacking and focus restoration to the invoker for free —
// each of which is a documented accessibility bug when hand-rolled. The element is
// created once, lazily, and reused; its text is set via textContent, never innerHTML.

export interface ConfirmOptions {
  message: string;
  /** Defaults to 'Confirm'. The label should name the ACTION ("Delete"), not "OK". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive. Default true — that is the main use. */
  danger?: boolean;
}

let dialog: HTMLDialogElement | null = null;
let messageEl: HTMLParagraphElement | null = null;
let confirmBtn: HTMLButtonElement | null = null;
let cancelBtn: HTMLButtonElement | null = null;

function ensureDialog(): HTMLDialogElement {
  if (dialog) return dialog;

  dialog = document.createElement('dialog');
  dialog.className = 'admin-dialog';

  messageEl = document.createElement('p');
  messageEl.className = 'dialog-message';

  // method="dialog" buttons close the dialog with their value as returnValue — no
  // click handlers, no state to desynchronise.
  const form = document.createElement('form');
  form.method = 'dialog';
  form.className = 'dialog-actions';

  // Cancel first in DOM order: showModal() focuses the first focusable control, and
  // initial focus on the SAFE action is the convention for destructive confirms — a
  // reflexive Enter then does nothing rather than deleting something.
  cancelBtn = document.createElement('button');
  cancelBtn.value = '';

  confirmBtn = document.createElement('button');
  confirmBtn.value = 'confirm';

  // appendChild, not append: the Cloudflare Workers types merge an HTMLRewriter
  // Element.append(content, options) into the global Element, and the clash breaks
  // overload resolution on the DOM's variadic append. appendChild has no twin.
  form.appendChild(cancelBtn);
  form.appendChild(confirmBtn);
  dialog.appendChild(messageEl);
  dialog.appendChild(form);
  document.body.appendChild(dialog);
  return dialog;
}

/** Resolves true on confirm; false on cancel, Escape, or backdrop dismissal. */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  const el = ensureDialog();
  if (!messageEl || !confirmBtn || !cancelBtn) return Promise.resolve(false);

  messageEl.textContent = opts.message;
  confirmBtn.textContent = opts.confirmLabel ?? 'Confirm';
  cancelBtn.textContent = opts.cancelLabel ?? 'Cancel';
  if (opts.danger ?? true) {
    confirmBtn.dataset['variant'] = 'danger';
  } else {
    delete confirmBtn.dataset['variant'];
  }

  return new Promise((resolve) => {
    el.addEventListener('close', () => resolve(el.returnValue === 'confirm'), { once: true });
    el.returnValue = '';
    el.showModal();
  });
}
