import { useEffect, useId, useRef, useState } from 'react';
import Modal from '@/components/admin/kit/Modal';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';

// "Erase a person's data" (Admin v2 C9b, crm.md §11 screen 8: "Contact picker (CRM lookup)"):
// the first step of an erasure started from CRM settings, the picker C7 left to this card. The
// search is sent as a POST body to the contacts lookup (never in an address; at most 8 answers,
// a name and a company only; a whole e-mail or phone finds its person by its blind index). A
// pick hands the contact to `onPick`, which opens C7's erase dialog: its preview, the reason
// and the second confirm are the same as on the contact's page.

export interface PickedContact {
  id: string;
  name: string;
  company: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (contact: PickedContact) => void;
}

/** What the search found, said once it lands (WCAG 4.1.3). */
export function foundWords(found: readonly PickedContact[] | null): string {
  if (found === null) return '';
  if (found.length === 0) return 'Nobody matches.';
  return found.length === 1 ? '1 contact found.' : `${found.length} contacts found.`;
}

export default function EraseFinder({ open, onClose, onPick }: Props) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<PickedContact[] | null>(null);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);

  // Each opening starts empty: a name typed for one erasure is not kept for the next.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setFound(null);
    setError('');
  }, [open]);

  useEffect(() => {
    const q = query.trim();
    pending.current?.abort();
    if (q.length < 2) {
      setFound(null);
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    const timer = window.setTimeout(() => {
      adminFetch<{
        contacts: { id: string; display_name: string | null; company_name: string | null }[];
      }>('/api/admin/crm/contacts/lookup', {
        method: 'POST',
        body: { q },
        signal: controller.signal,
      })
        .then((answer) => {
          if (controller.signal.aborted) return;
          setFound(
            answer.contacts.map((c) => ({
              id: c.id,
              name: c.display_name?.trim() || 'A contact with no name',
              company: c.company_name,
            })),
          );
          setError('');
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setFound(null);
          setError(
            err instanceof AdminApiError && err.info.status === 422
              ? 'Search by name or company. A whole e-mail or phone also works.'
              : describeError(err),
          );
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Erase a person's data"
      sub="Find the person first. You will see everything that would be erased before anything is."
      footer={
        <button type="button" data-autofocus="" onClick={onClose}>
          Cancel
        </button>
      }
    >
      <div className="f">
        <label className="f__l" htmlFor={`${id}-q`}>
          Who
        </label>
        <input
          id={`${id}-q`}
          type="search"
          value={query}
          autoComplete="off"
          placeholder="Search by name or company"
          aria-describedby={`${id}-hint`}
          onChange={(event) => setQuery(event.target.value)}
        />
        <p id={`${id}-hint`} className="f__hint">
          Type two letters or more.
        </p>
        {error && (
          <p className="field-error f__err" role="alert">
            {error}
          </p>
        )}
      </div>
      <p className="visually-hidden" role="status">
        {foundWords(found)}
      </p>
      {found && (
        <ul className="crm-found" aria-label="Contacts found">
          {found.length === 0 && <li className="f__hint">Nobody matches.</li>}
          {found.map((c) => (
            <li key={c.id}>
              <button type="button" data-size="sm" onClick={() => onPick(c)}>
                <span dir="auto">{c.name}</span>
                {c.company && (
                  <>
                    , <span dir="auto">{c.company}</span>
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
