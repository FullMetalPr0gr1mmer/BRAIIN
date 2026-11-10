import { useId, useState, type FormEvent } from 'react';
import Icon from '@/components/admin/kit/Icon';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';
import type { ChannelPresence } from '@/lib/crm/contactPage';

// Contact details (Admin v2 C7, crm.md §11 "PII rules"): masked until the person asks, with
// "Reveal contact details (this access is logged)". The reveal is POST
// /api/admin/crm/contacts/[id]/reveal: `crm.contacts`, a live recheck, the reveal limiter the
// lead reveal shares (60 an hour per person), and an audit row written BEFORE anything is
// decrypted (src/lib/crm/contactReveal.ts). What it answers lives in this island's state only:
// never storage, never the address, gone when the page is left. The Email, Call and WhatsApp
// links exist only after a reveal, and so does editing: add, make main, remove (one versioned
// PATCH each, sent through the page's queue, `edit`).

/** A revealed channel's value by its id. */
export type RevealedValues = ReadonlyMap<string, string | null>;

export const REVEAL_LIMIT_TEXT =
  'You have revealed 60 contact details in the last hour. Try again later.';

/** WhatsApp's link for a phone number: its digits only. */
export function whatsappHref(phone: string): string {
  return `https://wa.me/${phone.replace(/[^0-9]/g, '')}`;
}

const KIND_LABEL: Readonly<Record<string, string>> = { email: 'E-mail', phone: 'Phone' };

interface Props {
  contactId: string;
  channels: readonly ChannelPresence[];
  revealed: RevealedValues | null;
  onRevealed: (values: RevealedValues) => void;
  busy: boolean;
  /** One channel change through the page's queue; resolves to whether it saved. */
  edit: (change: {
    add?: { kind: 'email' | 'phone'; value: string }[];
    remove?: string[];
    primary?: string[];
  }) => Promise<boolean>;
}

export default function ContactChannelsCard({
  contactId,
  channels,
  revealed,
  onRevealed,
  busy,
  edit,
}: Props) {
  const id = useId();
  const [revealing, setRevealing] = useState(false);
  const [error, setError] = useState('');
  const [kind, setKind] = useState<'email' | 'phone'>('email');
  const [value, setValue] = useState('');

  async function reveal() {
    setRevealing(true);
    setError('');
    try {
      const answer = await adminFetch<{ channels: { id: string; value: string | null }[] }>(
        `/api/admin/crm/contacts/${contactId}/reveal`,
        { method: 'POST' },
      );
      onRevealed(new Map(answer.channels.map((c) => [c.id, c.value])));
    } catch (err) {
      setError(
        err instanceof AdminApiError && err.info.status === 429
          ? REVEAL_LIMIT_TEXT
          : err instanceof AdminApiError && err.info.status === 403
            ? 'Contact details are unavailable right now. Your role, or the activity log, refused the reveal.'
            : describeError(err),
      );
    } finally {
      setRevealing(false);
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    const typed = value.trim();
    if (!typed) {
      setError(kind === 'email' ? 'Type the e-mail address first.' : 'Type the number first.');
      return;
    }
    setError('');
    if (await edit({ add: [{ kind, value: typed }] })) setValue('');
  }

  const valueOf = (channel: ChannelPresence) => revealed?.get(channel.id) ?? null;
  // A channel that arrived after the reveal (a phone match confirmed, another tab) was not
  // revealed: it stays hidden, and the reveal is offered again for it.
  const unrevealed = revealed !== null && channels.some((c) => !revealed.has(c.id));
  const main = (k: string) => channels.find((c) => c.kind === k && c.is_primary);
  const email = main('email');
  const phone = main('phone');
  const emailValue = email ? valueOf(email) : null;
  const phoneValue = phone ? valueOf(phone) : null;

  return (
    <section className="card" aria-labelledby={`${id}-h`}>
      <div className="card__h">
        <div>
          <h2 id={`${id}-h`} className="card__t">
            Contact details
          </h2>
          <p className="card__sub">Shown one person at a time, and only when you ask.</p>
        </div>
      </div>
      {revealed && (emailValue || phoneValue) && (
        <div className="lead-links">
          {emailValue && (
            <a className="btn" data-size="sm" href={`mailto:${emailValue}`}>
              <Icon name="mail" size={16} />
              Email
            </a>
          )}
          {phoneValue && (
            <a className="btn" data-size="sm" href={`tel:${phoneValue}`}>
              <Icon name="phone" size={16} />
              Call
            </a>
          )}
          {phoneValue && (
            <a
              className="btn"
              data-size="sm"
              href={whatsappHref(phoneValue)}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Icon name="whatsapp" size={16} />
              WhatsApp<span className="visually-hidden"> (opens in a new tab)</span>
            </a>
          )}
        </div>
      )}
      {channels.length === 0 ? (
        <p className="f__hint">No e-mail address or phone number yet.</p>
      ) : (
        <ul className="ct-channels">
          {channels.map((channel) => {
            const label = `${KIND_LABEL[channel.kind] ?? 'Detail'}${channel.is_primary ? ' (main)' : ''}`;
            const shown = valueOf(channel);
            return (
              <li key={channel.id} className="ct-channels__i">
                <span className="ct-channels__k">{label}</span>
                {revealed === null || !revealed.has(channel.id) ? (
                  <span className="lead-masked">Hidden</span>
                ) : (
                  <span dir="ltr">{shown ?? 'Could not be read'}</span>
                )}
                {revealed && (
                  <span className="ct-channels__a">
                    {!channel.is_primary && (
                      <button
                        type="button"
                        data-size="sm"
                        disabled={busy}
                        onClick={() => void edit({ primary: [channel.id] })}
                      >
                        Make main<span className="visually-hidden"> {label}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      data-size="sm"
                      data-variant="ghost"
                      disabled={busy}
                      onClick={() => void edit({ remove: [channel.id] })}
                    >
                      Remove<span className="visually-hidden"> {label}</span>
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}
      {(revealed === null || unrevealed) && (
        <button type="button" disabled={revealing} onClick={() => void reveal()}>
          <Icon name="eye" size={16} />
          Reveal contact details (this access is logged)
        </button>
      )}
      {revealed !== null && (
        <form className="lead-log" onSubmit={(event) => void add(event)}>
          <div className="f">
            <label className="f__l" htmlFor={`${id}-kind`}>
              Add
            </label>
            <select
              id={`${id}-kind`}
              value={kind}
              onChange={(event) => setKind(event.target.value === 'phone' ? 'phone' : 'email')}
            >
              <option value="email">An e-mail address</option>
              <option value="phone">A phone number</option>
            </select>
          </div>
          <div className="f">
            <label className="f__l" htmlFor={`${id}-value`}>
              {kind === 'email' ? 'E-mail address' : 'Phone number, with its country code'}
            </label>
            <input
              id={`${id}-value`}
              type={kind === 'email' ? 'email' : 'tel'}
              dir="ltr"
              autoComplete="off"
              maxLength={kind === 'email' ? 254 : 32}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
          <button type="submit" disabled={busy}>
            Add
          </button>
        </form>
      )}
    </section>
  );
}
