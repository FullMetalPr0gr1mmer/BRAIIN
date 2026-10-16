import { useId, useState, type FormEvent } from 'react';
import { adminFetch, describeError } from '@/lib/admin/client';
import { ROLES, type Role } from '@/lib/auth/types';
import { ROLE_LABELS } from '@/lib/authz/capLabels';
import Note from '@/components/admin/kit/Note';

// Invite someone (the existing invite, POST /api/admin/users), on the kit's card. Admin v2
// U12b replaces it with the invite drawer, pending invites, Resend and Cancel, and the
// "Not set up" switch while e-mail delivery is off; U12a only moves it onto the card and
// lets the server refuse an address outside the Security card's allowed domain.

export interface InviteCardProps {
  onInvited: () => void;
}

export default function InviteCard({ onInvited }: InviteCardProps) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('content_creator');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const titleId = useId();
  const emailId = useId();
  const roleId = useId();
  const errorId = useId();

  async function invite(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setDone('');
    try {
      await adminFetch('/api/admin/users', { method: 'POST', body: { email, role } });
      setDone(`Invitation sent to ${email}.`);
      setEmail('');
      onInvited();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby={titleId}>
      <div className="card__h">
        <div>
          <h2 className="card__t" id={titleId}>
            Invite someone
          </h2>
          <p className="card__sub">They get an email with a link to set their password.</p>
        </div>
      </div>
      <form onSubmit={(event) => void invite(event)}>
        <div className="row-2">
          <div className="field">
            <label htmlFor={emailId}>Email</label>
            <input
              id={emailId}
              type="email"
              required
              autoComplete="off"
              dir="ltr"
              value={email}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={roleId}>Role</label>
            <select
              id={roleId}
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
            >
              {ROLES.map((option) => (
                <option key={option} value={option}>
                  {ROLE_LABELS[option]}
                </option>
              ))}
            </select>
          </div>
        </div>
        {error && (
          <Note tone="err" role="alert">
            <span id={errorId}>{error}</span>
          </Note>
        )}
        {done && (
          <Note tone="ok" role="status">
            {done}
          </Note>
        )}
        <div className="form-actions">
          <button type="submit" data-variant="primary" disabled={busy}>
            {busy ? 'Sending…' : 'Send invite'}
          </button>
        </div>
      </form>
    </section>
  );
}
