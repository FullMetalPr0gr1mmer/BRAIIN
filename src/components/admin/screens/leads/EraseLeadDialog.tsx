import { useId, useState } from 'react';
import Modal from '@/components/admin/kit/Modal';
import { adminFetch, describeError } from '@/lib/admin/client';
import { withFlash } from '@/lib/admin/flash';

// Erasing a lead (Admin v2 C4b, crm.md §11): an Admin's (`crm.erase`), behind "More actions"
// on the lead's page, as a danger action. Loaded with import() on first use, so the kit's
// Modal and this dialog never ride on the page's first load. The modal cannot be dismissed by
// a stray press (it is a decision with a reason); POST /api/admin/leads/[id]/erase writes the
// attempt to the activity log before it erases anything, then the outcome.

export interface EraseLeadDialogProps {
  leadId: string;
  open: boolean;
  onClose: () => void;
}

export default function EraseLeadDialog({ leadId, open, onClose }: EraseLeadDialogProps) {
  const name = useId();
  const [reason, setReason] = useState<'dsar' | 'decision' | ''>('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function erase() {
    if (!reason) {
      setError('Choose why the lead is erased.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await adminFetch(`/api/admin/leads/${leadId}/erase`, { method: 'POST', body: { reason } });
      // The confirmation rides to the list, which shows it (a toast here would go with this
      // page, unseen).
      location.assign(withFlash('/admin/leads', 'lead-erased'));
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={false}
      title="Erase this lead"
      sub="This deletes the lead, its notes and its timeline. It is logged in the activity log. Answer a request within 30 days."
      footer={
        <>
          <button type="button" data-autofocus="" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" data-variant="danger" disabled={busy} onClick={() => void erase()}>
            Erase the lead
          </button>
        </>
      }
    >
      <fieldset className="f f--group">
        <legend>Why</legend>
        <label className="field-inline">
          <input
            type="radio"
            name={name}
            value="dsar"
            checked={reason === 'dsar'}
            onChange={() => setReason('dsar')}
          />
          <span>Their request (PDPL)</span>
        </label>
        <label className="field-inline">
          <input
            type="radio"
            name={name}
            value="decision"
            checked={reason === 'decision'}
            onChange={() => setReason('decision')}
          />
          <span>Our decision</span>
        </label>
      </fieldset>
      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
