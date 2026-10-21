import { useEffect, useId, useState, type FormEvent } from 'react';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';
import { ROLES, type Role } from '@/lib/auth/types';
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '@/lib/authz/capLabels';
import { INVITE_LINK_LIFETIME } from '@/lib/admin/userModel';
import { INVITE_MESSAGE_MAX } from '@schemas/users';
import Drawer from '@/components/admin/kit/Drawer';
import Icon from '@/components/admin/kit/Icon';
import Note from '@/components/admin/kit/Note';

// The invite drawer (Admin v2 U12b, the prototype's opsInvite): e-mail, role, an optional
// name and an optional message for the invite e-mail. POST /api/admin/users decides
// everything again (the allowed domain, an address that already has an account, the limit,
// the message's rules). Opened only while invites are set up: the card that opens it says
// "Not set up" otherwise, and the API answers 503 the same.

export interface InviteDrawerProps {
  open: boolean;
  onClose: () => void;
  /** An invite went out: to whom (the address typed, for the notice). */
  onInvited: (email: string) => void;
}

interface Answer {
  email?: string;
}

export default function InviteDrawer({ open, onClose, onInvited }: InviteDrawerProps) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('content_creator');
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [errorField, setErrorField] = useState<string | null>(null);
  const formId = useId();
  const emailId = useId();
  const roleId = useId();
  const roleHintId = useId();
  const nameId = useId();
  const messageId = useId();
  const messageHintId = useId();
  const errorId = useId();

  useEffect(() => {
    if (!open) return;
    setEmail('');
    setRole('content_creator');
    setName('');
    setMessage('');
    setBusy(false);
    setError('');
    setErrorField(null);
  }, [open]);

  async function send(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setErrorField(null);
    try {
      const trimmedName = name.trim();
      const answer = await adminFetch<Answer>('/api/admin/users', {
        method: 'POST',
        body: {
          email,
          role,
          ...(trimmedName === '' ? {} : { displayName: trimmedName }),
          ...(message.trim() === '' ? {} : { message }),
        },
      });
      onInvited(answer.email ?? email.trim());
    } catch (err) {
      const field = err instanceof AdminApiError ? (err.info.field ?? null) : null;
      setErrorField(field);
      setError(describeError(err));
      setBusy(false);
    }
  }

  const emailInvalid = error !== '' && errorField === 'email';

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Invite someone"
      dismissible={false}
      footer={
        <div className="users-drawer__acts">
          <button type="submit" form={formId} data-variant="primary" disabled={busy}>
            <Icon name="send" />
            {busy ? 'Sending…' : 'Send invite'}
          </button>
        </div>
      }
    >
      <form id={formId} onSubmit={(event) => void send(event)} noValidate>
        <p className="admin-sub users-invite__lead">
          They get an email with a link to set their password. {INVITE_LINK_LIFETIME}
        </p>
        <div className="field">
          <label htmlFor={emailId}>Email</label>
          <input
            id={emailId}
            type="email"
            required
            maxLength={254}
            autoComplete="off"
            spellCheck={false}
            dir="ltr"
            value={email}
            aria-invalid={emailInvalid || undefined}
            aria-describedby={emailInvalid ? errorId : undefined}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={roleId}>Role</label>
          <select
            id={roleId}
            value={role}
            aria-describedby={roleHintId}
            onChange={(event) => setRole(event.target.value as Role)}
          >
            {ROLES.map((option) => (
              <option key={option} value={option}>
                {ROLE_LABELS[option]}
              </option>
            ))}
          </select>
          <p className="admin-sub" id={roleHintId}>
            {ROLE_DESCRIPTIONS[role]}
          </p>
        </div>
        <div className="field">
          <label htmlFor={nameId}>Name (optional)</label>
          <input
            id={nameId}
            type="text"
            maxLength={80}
            autoComplete="off"
            dir="auto"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={messageId}>Message (optional)</label>
          <textarea
            id={messageId}
            rows={3}
            maxLength={INVITE_MESSAGE_MAX}
            dir="auto"
            value={message}
            aria-describedby={messageHintId}
            onChange={(event) => setMessage(event.target.value)}
          />
        </div>
        <p className="admin-sub" id={messageHintId}>
          A short note in the invite email, up to {INVITE_MESSAGE_MAX} characters. Plain text only.
        </p>
        {error && (
          <Note tone="err" role="alert">
            <span id={errorId}>{error}</span>
          </Note>
        )}
      </form>
    </Drawer>
  );
}
