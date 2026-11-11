import { useEffect, useId, useState } from 'react';
import Modal from '@/components/admin/kit/Modal';
import { useClock } from '@/components/admin/kit/clock';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';
import { withFlash } from '@/lib/admin/flash';

// Erasing a person (Admin v2 C7, crm.md §11 screen 8): an Admin's (`crm.erase`), behind "More
// actions" on the contact's page. Loaded with import() on first use. On opening it asks POST
// …/erase-preview (its own limit; it reveals no contact detail) for what would go: their
// leads, notes, tasks and e-mails and phones, and the leads that match them by phone number
// alone, which the Admin ticks if they are this person's (Admin v2 C8b: each with the tasks
// that go with it, added to the count as it is ticked). Then the reason, the danger button "Erase
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

export interface ErasePreview {
  /** (C8) `tasks`: the follow-ups about the person or their certain leads. */
  counts: {
    leads: number;
    unindexed: number;
    channels: number;
    notes: number;
    tasks: number;
    /** (Admin v2 C16) The files kept with the person, removed first. */
    files?: number | undefined;
  };
  phoneMatches: {
    id: string;
    lead_number: number | null;
    name: string | null;
    company: string | null;
    created_at: string | null;
    /**
     * (C8 review, C8-SEC-4) The tasks on this lead that go too when it is ticked: none of them
     * is in `counts.tasks`.
     */
    tasks: number;
  }[];
}

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * The tasks the erasure would remove as it stands (Admin v2 C8b): the person's own
 * (`counts.tasks`) plus those of each phone match ticked, so the count follows the ticks. A
 * missing number (an answer from before C8) counts as none.
 */
export function erasedTasks(preview: ErasePreview, ticked: ReadonlySet<string>): number {
  const own = Number.isInteger(preview.counts.tasks) ? preview.counts.tasks : 0;
  return preview.phoneMatches.reduce(
    (sum, lead) => (ticked.has(lead.id) && Number.isInteger(lead.tasks) ? sum + lead.tasks : sum),
    own,
  );
}

/** The preview's first line after the name: "2 leads, 1 note, 3 tasks, 2 e-mails and phones." */
export function erasedLine(preview: ErasePreview, ticked: ReadonlySet<string>): string {
  return (
    `${n(preview.counts.leads, 'lead', 'leads')}, ${n(preview.counts.notes, 'note', 'notes')}, ` +
    `${n(erasedTasks(preview, ticked), 'task', 'tasks')}, ` +
    `${n(preview.counts.channels, 'e-mail or phone', 'e-mails and phones')}.`
  );
}

/** (Admin v2 C16) "Their 2 files go too, removed from storage first." */
export function erasedFilesLine(files: number): string {
  return `Their ${n(files, 'file', 'files')} ${files === 1 ? 'goes' : 'go'} too, removed from storage first.`;
}

export default function EraseContactDialog({
  open,
  onClose,
  contactId,
  name,
}: EraseContactDialogProps) {
  const { formatDate } = useClock();
  const group = useId();
  const [preview, setPreview] = useState<ErasePreview | null>(null);
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
    adminFetch<ErasePreview>(`/api/admin/crm/contacts/${contactId}/erase-preview`, {
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
      sub="This deletes the person, their leads, notes, tasks, e-mails and phone numbers. It cannot be undone. Logged in the audit log. Answer within 30 days."
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
            <span dir="auto">{name}</span>: {erasedLine(preview, ticked)}
          </p>
          {/* (Admin v2 C16) The files kept with them go first. */}
          {(preview.counts.files ?? 0) > 0 ? (
            <p>{erasedFilesLine(preview.counts.files ?? 0)}</p>
          ) : null}
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
                    {lead.tasks > 0 && `, with ${n(lead.tasks, 'task', 'tasks')}`}
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
