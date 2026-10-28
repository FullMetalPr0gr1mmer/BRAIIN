import { useId, useState, type FormEvent } from 'react';
import { SECTION_LABEL_MAX } from '@schemas/sectionTypes';
import Modal from '@/components/admin/kit/Modal';

// "Rename section" (Admin v2 E1, ui.md: "a small dialog, never a prompt"): the section's name
// in the admin, at most SECTION_LABEL_MAX characters. Empty puts back its kind's own name.
// The server holds the rule (packages/schemas/admin.ts SectionLabelSchema, 0115's CHECK): a
// refusal is said under the box. The name is not private (P-12: the copy says so): other
// staff see it, in the publish dialog and the site versions too once releases are on, and
// anon's table-level SELECT reads it on a visible section of a published page (0115).

export interface RenameModalProps {
  open: boolean;
  onClose: () => void;
  /** The section's own label, or null when it shows its kind's name. */
  label: string | null;
  /** Its kind's name, what an empty box gives it. */
  kindName: string;
  working: boolean;
  /** Why the last attempt was refused, in words. */
  error: string;
  onSave: (label: string | null) => void;
}

export default function RenameModal({
  open,
  onClose,
  label,
  kindName,
  working,
  error,
  onSave,
}: RenameModalProps) {
  const [value, setValue] = useState(label ?? '');
  const id = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    onSave(trimmed === '' ? null : trimmed);
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Rename section"
      sub="A name to tell this section apart in the admin. Others can see it, so keep private notes out of it."
      dismissible={false}
      footer={
        <>
          <button type="button" className="btn" data-variant="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn"
            data-variant="primary"
            form={`${id}-form`}
            disabled={working}
          >
            Save name
          </button>
        </>
      }
    >
      <form id={`${id}-form`} noValidate onSubmit={submit}>
        <div className="f" data-invalid={error ? '' : undefined}>
          <div className="f__l">
            <label htmlFor={`${id}-in`}>Section name</label>
            <span className="f__meta">
              {value.length}/{SECTION_LABEL_MAX}
            </span>
          </div>
          <input
            id={`${id}-in`}
            type="text"
            value={value}
            maxLength={SECTION_LABEL_MAX}
            autoComplete="off"
            dir="auto"
            aria-describedby={`${id}-hint${error ? ` ${id}-err` : ''}`}
            aria-invalid={error ? true : undefined}
            onChange={(e) => setValue(e.target.value)}
          />
          {error && (
            <p className="field-error f__err" id={`${id}-err`} role="alert">
              {error}
            </p>
          )}
          <p className="f__hint" id={`${id}-hint`}>
            Leave it empty to use the section’s own name, {kindName}.
          </p>
        </div>
      </form>
    </Modal>
  );
}
