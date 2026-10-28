import { useId } from 'react';
import Icon from '@/components/admin/kit/Icon';
import Modal from '@/components/admin/kit/Modal';
import { SECTION_KINDS, type Availability } from './library';

// "Add a section" (Admin v2 E1, ui.md "Add section"; the prototype's modal): every kind of
// section, each with its icon and a plain description. A kind this page may not take (made
// for another page, one it already has, or a second main heading or form) is shown with the
// reason and does nothing when pressed: `aria-disabled`, so it stays in the reading order and
// its reason is read with it, never a silent gap. Choosing one adds it hidden, at the end.

export interface AddSectionModalProps {
  open: boolean;
  onClose: () => void;
  options: readonly Availability[];
  /** A kind is being added: every option waits. */
  working: boolean;
  onPick: (type: string) => void;
}

export default function AddSectionModal({
  open,
  onClose,
  options,
  working,
  onPick,
}: AddSectionModalProps) {
  const base = useId();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a section"
      sub="It starts hidden, at the end of the page. Fill it in, move it, then show it."
      size="lg"
    >
      <ul className="pe__lib">
        {options.map((option) => {
          const kind = SECTION_KINDS[option.type];
          const name = `${base}-${option.type}-n`;
          const why = `${base}-${option.type}-d`;
          const off = !option.ok || working;
          return (
            <li key={option.type}>
              <button
                type="button"
                className="pe__libitem"
                aria-disabled={off ? 'true' : undefined}
                aria-labelledby={name}
                aria-describedby={why}
                onClick={() => {
                  if (!off) onPick(option.type);
                }}
              >
                <span className="li__ico">
                  <Icon name={kind.icon} size={17} />
                </span>
                <span className="pe__libtext">
                  <span className="pe__libname" id={name}>
                    {kind.name}
                  </span>
                  <span className="pe__libsub" id={why}>
                    {option.ok ? kind.description : option.reason}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
