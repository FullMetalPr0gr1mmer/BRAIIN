import Modal from '@/components/admin/kit/Modal';

// Reset's confirm (Admin v2 U1): back to the role's layout, after asking. Its own module so
// the dashboard's eager island carries no Modal: it loads with the other editing pieces
// (the admin-dashboard chunk) when Customize is first used.

export interface ResetModalProps {
  open: boolean;
  onClose: () => void;
  /** The person arranged their own layout (else Reset changes nothing). */
  mine: boolean;
  onReset: () => void;
}

export default function ResetModal({ open, onClose, mine, onReset }: ResetModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Reset the dashboard?"
      sub={
        mine
          ? 'Back to the layout for your role. Only your dashboard changes.'
          : 'Your dashboard already shows the layout for your role.'
      }
      footer={
        <>
          <button type="button" data-autofocus="" onClick={onClose}>
            Cancel
          </button>
          <button type="button" data-variant="primary" onClick={onReset}>
            Reset
          </button>
        </>
      }
    >
      <p>Your quick actions stay as they are.</p>
    </Modal>
  );
}
