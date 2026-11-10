import { useId, useState } from 'react';
import { Badge } from '@/components/admin/kit/StatusBadge';
import { useClock } from '@/components/admin/kit/clock';
import { adminFetch, describeError } from '@/lib/admin/client';
import { isoOf } from '@/lib/admin/relTime';
import type { StageView } from '@/lib/crm/leadPage';
import type { ContactLead } from '@/lib/crm/contactView';

// A contact's leads (Admin v2 C7, crm.md §11 screen 6): every lead linked to the person,
// newest first, each with its number, stage and arrival, linked to its page. A lead matched by
// phone number alone is not the person's until someone says so (a phone can be shared, C5): it
// asks "Is this the same person?" and sends POST …/links, `confirm` (it is: the lead's e-mail
// and phone join the contact) or `detach` (it is not: the lead leaves the contact for good).
// The answer says what was copied, by kind, never a value.

/** What POST …/links answers. */
interface LinkAnswer {
  link: string;
  email: string | null;
  phone: string | null;
}

/** What a confirmed match copied, in words ('' when everything went as expected). */
export function copiedWords(answer: LinkAnswer): string {
  const words: string[] = [];
  if (answer.email === 'elsewhere')
    words.push('Its e-mail address belongs to another contact, so it stayed there.');
  if (answer.email === 'full')
    words.push('This contact already keeps 10 e-mail addresses, so the lead’s was not added.');
  if (answer.phone === 'full')
    words.push('This contact already keeps 10 phone numbers, so the lead’s was not added.');
  return words.join(' ');
}

interface Props {
  leads: readonly ContactLead[];
  more: boolean;
  stages: readonly StageView[];
  contactId: string;
  canAddLead: boolean;
  onNewLead: () => void;
  /** After a match was checked: the contact and its timeline are read again. */
  onChecked: (said: string) => void;
}

export default function ContactLeadsCard({
  leads,
  more,
  stages,
  contactId,
  canAddLead,
  onNewLead,
  onChecked,
}: Props) {
  const { formatDate } = useClock();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function check(lead: ContactLead, action: 'confirm' | 'detach') {
    setBusy(true);
    setError('');
    try {
      const answer = await adminFetch<LinkAnswer>(`/api/admin/crm/contacts/${contactId}/links`, {
        method: 'POST',
        body: { leadId: lead.id, action },
      });
      const extra = action === 'confirm' ? copiedWords(answer) : '';
      onChecked(
        action === 'confirm'
          ? `Linked to this contact.${extra ? ` ${extra}` : ''}`
          : 'The lead no longer belongs to this contact.',
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby={`${id}-h`}>
      <div className="card__h">
        <h2 id={`${id}-h`} className="card__t">
          Leads
        </h2>
        {canAddLead && (
          <button type="button" data-size="sm" onClick={onNewLead}>
            New lead
          </button>
        )}
      </div>
      {leads.length === 0 ? (
        <p className="f__hint">No leads yet.</p>
      ) : (
        <ul className="ct-leads">
          {leads.map((lead) => {
            const stage = stages.find((s) => s.id === lead.stage_id);
            const label = lead.lead_number === null ? 'A lead' : `#${lead.lead_number}`;
            return (
              <li key={lead.id} className="ct-leads__i">
                <p className="ct-leads__n">
                  <a href={`/admin/leads/${lead.id}`}>
                    {label}
                    {lead.name && (
                      <>
                        {' '}
                        <span dir="auto">{lead.name}</span>
                      </>
                    )}
                  </a>
                </p>
                <p className="ct-leads__m">
                  <Badge tone={stage?.tone ?? 'gray'}>{stage?.label ?? 'No stage'}</Badge>
                  {lead.is_spam && <Badge tone="err">Spam</Badge>}
                  <time dateTime={isoOf(lead.created_at)}>{formatDate(lead.created_at)}</time>
                </p>
                {lead.contact_link === 'phone' && (
                  <div className="ct-leads__check" role="group" aria-label={`Check ${label}`}>
                    <p>Matched by phone number only. Is this the same person?</p>
                    <button
                      type="button"
                      data-size="sm"
                      disabled={busy}
                      onClick={() => void check(lead, 'confirm')}
                    >
                      Yes, same person<span className="visually-hidden"> ({label})</span>
                    </button>
                    <button
                      type="button"
                      data-size="sm"
                      data-variant="ghost"
                      disabled={busy}
                      onClick={() => void check(lead, 'detach')}
                    >
                      Not this person<span className="visually-hidden"> ({label})</span>
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {more && <p className="f__hint">Showing the newest 50 leads.</p>}
      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
