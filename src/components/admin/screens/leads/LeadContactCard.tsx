import { useId, useState } from 'react';
import Icon from '@/components/admin/kit/Icon';
import { budgetBandLabel } from '@schemas/lead';
import { LEAD_CONTACT_CHANNELS, type LeadContactChannel, type ScoreSignal } from '@schemas/crm';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';

// Contact & budget (Admin v2 C4b, crm.md §11 "PII rules"): masked until the person asks,
// with "Reveal contact details (this access is logged)". The reveal is POST
// /api/admin/leads/[id]/reveal: `leads.pii`, a live recheck, 60 an hour per person, and an
// audit row written BEFORE anything is decrypted (src/lib/crm/reveal.ts). What it answers
// lives in the detail island's state only: never storage, never the address, gone when the
// page is left. The Email, Call and WhatsApp links exist only after a reveal, and "Log
// contact" records that a contact was made (one PATCH, no values).

/** What the reveal answers (the score's reasons too, decision D7). */
export interface Revealed {
  email: string | null;
  phone: string | null;
  budget: string | null;
  timeline: string | null;
  score_reasons: ScoreSignal[];
}

const CONTACT_LABELS: Readonly<Record<LeadContactChannel, string>> = {
  call: 'Call',
  email: 'E-mail',
  whatsapp: 'WhatsApp',
  meeting: 'Meeting',
  other: 'Something else',
};

export const REVEAL_LIMIT_TEXT =
  'You have revealed 60 contact details in the last hour. Try again later.';

/** WhatsApp's link for a phone number: its digits only. */
export function whatsappHref(phone: string): string {
  return `https://wa.me/${phone.replace(/[^0-9]/g, '')}`;
}

/** The visitor's own words, or a legacy band's (the cron stored it there, encrypted, 0035). */
function timelineText(revealed: Revealed): string {
  return revealed.timeline || 'Not given';
}

interface Props {
  leadId: string;
  revealed: Revealed | null;
  onRevealed: (revealed: Revealed) => void;
  /** After "Log contact": the lead and its timeline are read again. */
  onLogged: () => void;
}

export default function LeadContactCard({ leadId, revealed, onRevealed, onLogged }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [channel, setChannel] = useState<LeadContactChannel>('call');
  const [logged, setLogged] = useState('');
  const channelId = useId();

  async function reveal() {
    setBusy(true);
    setError('');
    try {
      onRevealed(
        await adminFetch<Revealed>(`/api/admin/leads/${leadId}/reveal`, { method: 'POST' }),
      );
    } catch (err) {
      setError(
        err instanceof AdminApiError && err.info.status === 429
          ? REVEAL_LIMIT_TEXT
          : err instanceof AdminApiError && err.info.status === 403
            ? 'Contact details are unavailable right now. Your role, or the activity log, refused the reveal.'
            : describeError(err),
      );
    } finally {
      setBusy(false);
    }
  }

  async function log() {
    setBusy(true);
    setError('');
    setLogged('');
    try {
      await adminFetch(`/api/admin/leads/${leadId}`, {
        method: 'PATCH',
        body: { logContact: { channel } },
      });
      setLogged(`${CONTACT_LABELS[channel]} logged.`);
      onLogged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const rows: [string, string | null][] = revealed
    ? [
        ['E-mail', revealed.email],
        ['Phone', revealed.phone],
        ['Budget', revealed.budget ? budgetBandLabel(revealed.budget, 'en') : null],
        ['When they need it', timelineText(revealed)],
      ]
    : [
        ['E-mail', null],
        ['Phone', null],
        ['Budget', null],
        ['When they need it', null],
      ];

  return (
    <section className="card" aria-labelledby={`${channelId}-h`}>
      <div className="card__h">
        <div>
          <h2 id={`${channelId}-h`} className="card__t">
            Contact &amp; budget
          </h2>
          <p className="card__sub">Shown one lead at a time, and only when you ask.</p>
        </div>
      </div>
      {revealed && (
        <div className="lead-links">
          {revealed.email && (
            <a className="btn" data-size="sm" href={`mailto:${revealed.email}`}>
              <Icon name="mail" size={16} />
              Email
            </a>
          )}
          {revealed.phone && (
            <a className="btn" data-size="sm" href={`tel:${revealed.phone}`}>
              <Icon name="phone" size={16} />
              Call
            </a>
          )}
          {revealed.phone && (
            <a
              className="btn"
              data-size="sm"
              href={whatsappHref(revealed.phone)}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Icon name="whatsapp" size={16} />
              WhatsApp<span className="visually-hidden"> (opens in a new tab)</span>
            </a>
          )}
        </div>
      )}
      <dl className="stat-rows">
        {rows.map(([label, value]) => (
          <div className="stat-row" key={label}>
            <dt>{label}</dt>
            <dd>
              {revealed === null ? (
                <span className="lead-masked">Hidden</span>
              ) : value ? (
                <span dir={label === 'E-mail' || label === 'Phone' ? 'ltr' : 'auto'}>{value}</span>
              ) : (
                'Not given'
              )}
            </dd>
          </div>
        ))}
      </dl>
      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}
      {revealed === null ? (
        <button type="button" disabled={busy} onClick={() => void reveal()}>
          <Icon name="eye" size={16} />
          Reveal contact details (this access is logged)
        </button>
      ) : (
        <div className="lead-log">
          <div className="f">
            <label className="f__l" htmlFor={channelId}>
              Log contact
            </label>
            <select
              id={channelId}
              value={channel}
              onChange={(event) => setChannel(event.target.value as LeadContactChannel)}
            >
              {LEAD_CONTACT_CHANNELS.map((key) => (
                <option key={key} value={key}>
                  {CONTACT_LABELS[key]}
                </option>
              ))}
            </select>
          </div>
          <button type="button" disabled={busy} onClick={() => void log()}>
            Log
          </button>
          <p className="visually-hidden" role="status">
            {logged}
          </p>
        </div>
      )}
    </section>
  );
}
