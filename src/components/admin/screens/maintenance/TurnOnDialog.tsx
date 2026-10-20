import Modal from '@/components/admin/kit/Modal';

// "Put the site in maintenance mode?" (Admin v2 U9b; the prototype's confirmDlg, danger): the
// kit's modal, Cancel first and focused. What it says follows who will still see the site:
// the signed-in team (the bypass on), or only the allowed addresses, and when that is nobody
// it says so (the old screen's empty-allowlist confirmation, now only when the bypass is off).

export const TURN_ON_TITLE = 'Put the site in maintenance mode?';

export function turnOnText(bypass: boolean, allowed: number): string {
  const when = 'Every visitor sees the maintenance page within about a minute.';
  if (bypass) return `${when} Your signed in team still sees the site.`;
  if (allowed === 0) {
    return `${when} No address is allowed, so everyone sees it, you included. The admin stays open.`;
  }
  return `${when} Only the addresses you allow still see the site.`;
}

interface Props {
  open: boolean;
  bypass: boolean;
  allowed: number;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function TurnOnDialog({ open, bypass, allowed, onCancel, onConfirm }: Props) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={TURN_ON_TITLE}
      sub={turnOnText(bypass, allowed)}
      footer={
        <>
          <button type="button" className="btn" data-variant="ghost" data-autofocus onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn" data-variant="danger" onClick={onConfirm}>
            Turn on
          </button>
        </>
      }
    >
      <p className="admin-sub">Turning it on also saves the settings as they are on screen.</p>
    </Modal>
  );
}
