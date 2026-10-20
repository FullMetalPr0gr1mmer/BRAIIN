import { useId, useState } from 'react';
import { adminFetch, describeError } from '@/lib/admin/client';
import { ROLE_LABELS } from '@/lib/authz/capLabels';
import { useClock } from '@/components/admin/kit/clock';
import {
  INVITES_NOT_SET_UP,
  INVITE_LINK_LIFETIME,
  canCancelInvite,
  canResendInvite,
  personName,
  type UserRow,
} from '@/lib/admin/userModel';
import Icon from '@/components/admin/kit/Icon';
import ListRow from '@/components/admin/kit/ListRow';
import Modal from '@/components/admin/kit/Modal';
import Note from '@/components/admin/kit/Note';
import { Badge } from '@/components/admin/kit/StatusBadge';

// Pending invites (Admin v2 U12b, the prototype's "Pending invites" card): the people invited
// who have not set a password yet, each with Resend and Cancel (confirmed), and the card's
// "Invite someone", which opens the invite drawer. While the site cannot send e-mail
// (AUTH_EMAIL_READY, owner items O-2 and O-22) Invite someone and Resend say "Not set up"
// and send nothing; the list and Cancel still work. The server decides every one of them
// again (POST /api/admin/users, POST /api/admin/users/[id]/resend, DELETE
// /api/admin/users/[id]/invite): these buttons only save a pointless round trip.

export interface PendingInvitesProps {
  pending: readonly UserRow[];
  /** E-mail delivery is set up (the server's AUTH_EMAIL_READY). */
  emailReady: boolean;
  onInvite: () => void;
  /** Something changed: what to say, and the list is read again. */
  onChanged: (message: string) => void;
}

export default function PendingInvites({
  pending,
  emailReady,
  onInvite,
  onChanged,
}: PendingInvitesProps) {
  const { relTime } = useClock();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState<UserRow | null>(null);
  const titleId = useId();
  const offId = useId();

  async function resend(row: UserRow) {
    setBusyId(row.id);
    setError('');
    try {
      await adminFetch(`/api/admin/users/${encodeURIComponent(row.id)}/resend`, {
        method: 'POST',
        body: {},
      });
      onChanged(`Invite sent again to ${row.email ?? personName(row)}.`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyId(null);
    }
  }

  async function cancel(row: UserRow) {
    setBusyId(row.id);
    setError('');
    try {
      await adminFetch(`/api/admin/users/${encodeURIComponent(row.id)}/invite`, {
        method: 'DELETE',
      });
      setCancelling(null);
      onChanged(`Invite cancelled. ${row.email ?? personName(row)} cannot join with that link.`);
    } catch (err) {
      setCancelling(null);
      setError(describeError(err));
    } finally {
      setBusyId(null);
    }
  }

  const who = cancelling ? (cancelling.email ?? personName(cancelling)) : '';

  return (
    <section className="card" aria-labelledby={titleId}>
      <div className="card__h">
        <div>
          <h2 className="card__t" id={titleId}>
            Pending invites
          </h2>
          <p className="card__sub">They get an email with a link to set their password.</p>
        </div>
        <div className="users-invites__head">
          {!emailReady && <Badge tone="gray">{INVITES_NOT_SET_UP.title}</Badge>}
          <button
            type="button"
            data-size="sm"
            data-variant="primary"
            disabled={!emailReady}
            aria-describedby={emailReady ? undefined : offId}
            onClick={onInvite}
          >
            <Icon name="plus" />
            Invite someone
          </button>
        </div>
      </div>

      {emailReady ? (
        <p className="admin-sub users-invites__lead">{INVITE_LINK_LIFETIME}</p>
      ) : (
        <Note tone="info">
          <span id={offId}>{INVITES_NOT_SET_UP.text}</span>
        </Note>
      )}

      {error && (
        <Note tone="err" role="alert">
          {error}
        </Note>
      )}

      {pending.length === 0 ? (
        <p className="admin-sub">No pending invites.</p>
      ) : (
        <ul className="list users-invites" aria-label="Pending invites">
          {pending.map((row) => {
            const name = row.email ?? personName(row);
            const busy = busyId === row.id;
            const sub = [
              ROLE_LABELS[row.role],
              row.invitedAt ? `invited ${relTime(row.invitedAt)}` : null,
              row.isActive ? null : 'Can sign in is off',
            ]
              .filter((part) => part !== null)
              .join(' · ');
            return (
              <ListRow
                key={row.id}
                icon="mail"
                title={name}
                sub={sub}
                actions={
                  <>
                    <button
                      type="button"
                      data-size="sm"
                      disabled={!emailReady || !canResendInvite(row) || busyId !== null}
                      aria-label={`Resend the invite to ${name}`}
                      onClick={() => void resend(row)}
                    >
                      {busy && !cancelling ? 'Sending…' : 'Resend'}
                    </button>
                    {canCancelInvite(row) && (
                      <button
                        type="button"
                        data-size="sm"
                        data-variant="ghost"
                        disabled={busyId !== null}
                        aria-label={`Cancel the invite to ${name}`}
                        onClick={() => {
                          setError('');
                          setCancelling(row);
                        }}
                      >
                        Cancel
                      </button>
                    )}
                  </>
                }
              />
            );
          })}
        </ul>
      )}

      <Modal
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        title="Cancel invite?"
        sub={`${who} will not be able to join with this link.`}
        dismissible={false}
        footer={
          <>
            <button type="button" data-autofocus="" onClick={() => setCancelling(null)}>
              Keep invite
            </button>
            <button
              type="button"
              data-variant="danger"
              disabled={busyId !== null}
              onClick={() => cancelling && void cancel(cancelling)}
            >
              Cancel invite
            </button>
          </>
        }
      >
        <p>The account they were invited to is removed. You can invite them again later.</p>
      </Modal>
    </section>
  );
}
