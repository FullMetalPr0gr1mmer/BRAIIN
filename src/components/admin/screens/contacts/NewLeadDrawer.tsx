import { useId, useState, type FormEvent } from 'react';
import Drawer from '@/components/admin/kit/Drawer';
import { BUDGET_BANDS, BUDGET_BAND_LABELS } from '@schemas/lead';
import { MANUAL_LEAD_CHANNELS, type ContactNewLead } from '@schemas/crm';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';
import { withFlash } from '@/lib/admin/flash';
import { CHANNEL_LABELS } from '@/lib/crm/leadView';
import type { ContactDetailRow } from '@/lib/crm/contactPage';
import { contactName } from '@/lib/crm/contactView';

// "New lead" from a contact (Admin v2 C7, crm.md §9 and §11 screen 6): `crm.contacts` with
// `leads.manage` and `leads.pii` (the route checks all three). The contact's own e-mail and
// phone go on the lead, copied by the database as ciphertext, so this form never sends one;
// the lead is linked to this contact. Loaded with import() on first use. The lead's name,
// company and language default to the contact's.

export interface NewLeadDrawerProps {
  open: boolean;
  onClose: () => void;
  contact: ContactDetailRow;
}

export default function NewLeadDrawer({ open, onClose, contact }: NewLeadDrawerProps) {
  const id = useId();
  const [message, setMessage] = useState('');
  const [channel, setChannel] = useState<(typeof MANUAL_LEAD_CHANNELS)[number]>('phone');
  const [budget, setBudget] = useState('');
  const [timeline, setTimeline] = useState('');
  const [error, setError] = useState('');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure('');
    if (!message.trim()) {
      setError('Write what they asked for.');
      return;
    }
    setError('');
    setBusy(true);
    const body: ContactNewLead = { message: message.trim(), channel };
    if (budget) body.budgetBand = budget as NonNullable<ContactNewLead['budgetBand']>;
    if (timeline.trim()) body.timeline = timeline.trim();
    try {
      const added = await adminFetch<{ id: string }>(
        `/api/admin/crm/contacts/${contact.id}/leads`,
        { method: 'POST', body },
      );
      location.assign(withFlash(`/admin/leads/${added.id}`, 'lead-added'));
    } catch (err) {
      setBusy(false);
      setFailure(
        err instanceof AdminApiError && err.info.status === 429
          ? 'You have added a lot of leads in the last hour. Try again later.'
          : describeError(err),
      );
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={
        <>
          New lead for <span dir="auto">{contactName(contact)}</span>
        </>
      }
      dismissible={false}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form={`${id}-form`} data-variant="primary" disabled={busy}>
            Add lead
          </button>
        </>
      }
    >
      <form id={`${id}-form`} className="lead-add" onSubmit={(e) => void submit(e)} noValidate>
        <p className="admin-sub">
          Their e-mail address and phone number go on the lead from this contact.
        </p>
        {failure && (
          <p className="msg" data-kind="error" role="alert">
            {failure}
          </p>
        )}
        <div className="f">
          <label className="f__l" htmlFor={`${id}-message`}>
            <span>
              Message
              <span className="req" aria-hidden="true">
                {' '}
                *
              </span>
              <span className="visually-hidden"> (required)</span>
            </span>
          </label>
          <textarea
            id={`${id}-message`}
            rows={4}
            maxLength={5000}
            dir="auto"
            placeholder="What did they ask for?"
            value={message}
            aria-required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-message-error` : undefined}
            onChange={(event) => setMessage(event.target.value)}
          />
          {error && (
            <p id={`${id}-message-error`} className="field-error f__err">
              {error}
            </p>
          )}
        </div>
        <div className="lead-add__row">
          <div className="f">
            <label className="f__l" htmlFor={`${id}-channel`}>
              How they reached us
            </label>
            <select
              id={`${id}-channel`}
              value={channel}
              onChange={(event) =>
                setChannel(event.target.value as (typeof MANUAL_LEAD_CHANNELS)[number])
              }
            >
              {MANUAL_LEAD_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {CHANNEL_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
          <div className="f">
            <label className="f__l" htmlFor={`${id}-budget`}>
              Budget
            </label>
            <select
              id={`${id}-budget`}
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
            >
              <option value="">Not given</option>
              {BUDGET_BANDS.map((band) => (
                <option key={band} value={band}>
                  {BUDGET_BAND_LABELS[band].en}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="f">
          <label className="f__l" htmlFor={`${id}-timeline`}>
            When do you need it?
          </label>
          <input
            id={`${id}-timeline`}
            maxLength={120}
            dir="auto"
            autoComplete="off"
            value={timeline}
            onChange={(event) => setTimeline(event.target.value)}
          />
        </div>
      </form>
    </Drawer>
  );
}
