import { useEffect, useId, useState } from 'react';
import Modal from '@/components/admin/kit/Modal';
import { sanitizeHref } from '@/lib/content/tiptap';

// The rich-text editor's link dialog (Admin v2 F5a, ui.md §2.6: "Links open in a dialog,
// never prompt()"), on the kit's Modal. FormField hands it to RichText as a prop: RichText
// is the lazy admin-rich chunk, and a shared module it imported itself would be pulled in
// there (scripts/admin-bundle.mjs would then see every screen load the editor eagerly).
//
// An address is checked with the public renderer's own rule (sanitizeHref in
// src/lib/content/tiptap.ts: http, https, mailto, tel, or a path on this site), the one that
// decides whether the link is drawn at all, so the dialog never accepts a link the page
// would silently drop. The server still validates the document; the renderer is the gate.

export interface LinkDialogProps {
  open: boolean;
  /** The link under the cursor, or '' for a new one. */
  href: string;
  /** What the link is in, for the title ("Link in Body English"). */
  label: string;
  onClose: () => void;
  onSave: (href: string) => void;
  onRemove: () => void;
}

export default function LinkDialog({
  open,
  href,
  label,
  onClose,
  onSave,
  onRemove,
}: LinkDialogProps) {
  const [draft, setDraft] = useState(href);
  const [error, setError] = useState('');
  const inputId = useId();
  const errorId = `${inputId}-error`;
  useEffect(() => {
    if (open) {
      setDraft(href);
      setError('');
    }
  }, [open, href]);

  function save() {
    const safe = sanitizeHref(draft);
    if (!safe) {
      setError(
        'Use a web address (https://…), a page on this site (/about), an email (mailto:…) or a phone number (tel:…).',
      );
      return;
    }
    onSave(safe);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={href ? 'Edit link' : 'Add a link'}
      sub={label}
      dismissible={false}
      footer={
        <>
          {href && (
            <button type="button" data-variant="danger" onClick={onRemove}>
              Remove link
            </button>
          )}
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" data-variant="primary" onClick={save}>
            {href ? 'Update link' : 'Add link'}
          </button>
        </>
      }
    >
      <div className="f">
        <div className="f__l">
          <label htmlFor={inputId}>Link address</label>
        </div>
        <input
          id={inputId}
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // The dialog sits inside the edit <form>: Enter saves the link, never the form.
            if (e.key === 'Enter') {
              e.preventDefault();
              save();
            }
          }}
        />
        {error && (
          <p id={errorId} className="field-error f__err">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
