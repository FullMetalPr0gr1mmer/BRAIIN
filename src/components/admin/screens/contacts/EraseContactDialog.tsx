import { useEffect, useId, useState } from 'react';
import Modal from '@/components/admin/kit/Modal';
import { useClock } from '@/components/admin/kit/clock';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';
import { withFlash } from '@/lib/admin/flash';

// Erasing a person (Admin v2 C7, crm.md §11 screen 8): an Admin's (`crm.erase`), behind "More
// actions" on the contact's page. Loaded with import() on first use. On opening it asks POST
// …/erase-preview (its own limit; it reveals no contact detail) for what would go: their
// leads, notes and e-mails and phones, and the leads that match them by phone number alone,
// which the Admin ticks if they are this person's. Then the reason, the danger button "Erase
// everything about them", and a second confirm, before POST …/erase writes the attempt to the
// activity log and erases (src/pages/api/admin/crm/contacts/[id]/erase.ts). The modal cannot
// be dismissed by a stray press.

export interface EraseContactDialogProps {
  open: boolean;
  onClose: () => void;
  contactId: string;
  name: string;
}

export type EraseReason = 'dsar' | 'decision' | '';

/**
 * The dialog's two steps (crm.md §11: "then a second confirm"): the first press asks again,
 * the second erases. Never without a reason.
 */
export function eraseStep(
  step: 'choose' | 'confirm',
  reason: EraseReason,
): { next: 'choose' | 'confirm' | 'erase'; error: string } {
  if (!reason) return { next: 'choose', error: 'Choose why their data is erased.' };
  return step === 'choose' ? { next: 'confirm', error: '' } : { next: 'erase', error: '' };
}

interface Preview {
  counts: { leads: number; unindexed: number; channels: number; notes: number };
  phoneMatches: {
    id: string;
    lead_number: number | null;
    name: string | null;
    company: string | null;
    created_at: string | null;
  }[];
}

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export default function EraseContactDialog({
  open,
  onClose,
  contactId,
  name,
}: EraseContactDialogProps) {
  const { formatDate } = useClock();
  const group = useId();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set());
  const [reason, setReason] = useState<EraseReason>('');
  const [step, setStep] = useState<'choose' | 'confirm'>('choose');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Each opening reads the preview afresh and starts at the first step.
  useEffect(() => {
    if (!open) return;
    setStep('choose');
    setError('');
    setPreview(null);
    setTicked(new Set());
    const controller = new AbortController();
    adminFetch<Preview>(`/api/admin/crm/contacts/${contactId}/erase-preview`, {
      method: 'POST',
      signal: controller.signal,
    })
      .then(setPreview)
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          err instanceof AdminApiError && err.info.status === 429
            ? 'You have opened this a lot in the last hour. Try again later.'
            : describeError(err),
        );
      });
    return () => controller.abort();
  }, [open, contactId]);

  async function press() {
    const outcome = eraseStep(step, reason);
    setError(outcome.error);
    if (outcome.next !== 'erase') {
      setStep(outcome.next);
      return;
    }
    setBusy(true);
    try {
      await adminFetch(`/api/admin/crm/contacts/${contactId}/erase`, {
        method: 'POST',
        body: { reason, ...(ticked.size > 0 ? { extraLeads: [...ticked] } : {}) },
      });
      location.assign(withFlash('/admin/contacts', 'contact-erased'));
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
      setStep('choose');
    }
  }

  // A change after the first press asks for the confirm again: it confirms what is chosen.
  const choose = (why: EraseReason) => {
    setReason(why);
    setStep('choose');
  };
  const toggle = (lead: string) => {
    setStep('choose');
    setTicked((set) => {
      const next = new Set(set);
      if (next.has(lead)) next.delete(lead);
      else next.add(lead);
      return next;
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={false}
      title="Erase everything about them"
      sub="This deletes the person, their leads, notes, e-mails and phone numbers. It cannot be undone. Logged in the audit log. Answer within 30 days."
      footer={
        <>
          <button type="button" data-autofocus="" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            data-variant="danger"
            disabled={busy || preview === null}
            onClick={() => void press()}
          >
            {step === 'confirm' ? 'Yes, erase now' : 'Erase everything about them'}
          </button>
        </>
      }
    >
      {preview === null ? (
        !error && <p className="f__hint">Checking what would be erased…</p>
      ) : (
        <>
          <p>
            <span dir="auto">{name}</span>: {n(preview.counts.leads, 'lead', 'leads')},{' '}
            {n(preview.counts.notes, 'note', 'notes')},{' '}
            {n(preview.counts.channels, 'e-mail or phone', 'e-mails and phones')}.
          </p>
          {preview.counts.unindexed > 0 && (
            <p className="f__hint">
              {n(preview.counts.unindexed, 'recent lead', 'recent leads')} could not be checked
              against them yet. Try again in a few minutes to include any that are theirs.
            </p>
          )}
          {preview.phoneMatches.length > 0 && (
            <fieldset className="f f--group">
              <legend>
                These leads share their phone number. Tick the ones that are this person.
              </legend>
              {preview.phoneMatches.map((lead) => (
                <label key={lead.id} className="field-inline">
                  <input
                    type="checkbox"
                    checked={ticked.has(lead.id)}
                    onChange={() => toggle(lead.id)}
                  />
                  <span>
                    {lead.lead_number === null ? 'A lead' : `#${lead.lead_number}`}{' '}
                    <span dir="auto">{lead.name ?? ''}</span>
                    {lead.company && (
                      <>
                        {', '}
                        <span dir="auto">{lead.company}</span>
                      </>
                    )}
                    {lead.created_at && `, ${formatDate(lead.created_at)}`}
                  </span>
                </label>
              ))}
            </fieldset>
          )}
        </>
      )}
      <fieldset className="f f--group">
        <legend>Why</legend>
        <label className="field-inline">
          <input
            type="radio"
            name={group}
            value="dsar"
            checked={reason === 'dsar'}
            onChange={() => choose('dsar')}
          />
          <span>Their request (DSAR)</span>
        </label>
        <label className="field-inline">
          <input
            type="radio"
            name={group}
            value="decision"
            checked={reason === 'decision'}
            onChange={() => choose('decision')}
          />
          <span>Our decision</span>
        </label>
      </fieldset>
      {step === 'confirm' && (
        <p className="msg" data-kind="error" role="alert">
          Are you sure? This erases everything about them for good.
        </p>
      )}
      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
