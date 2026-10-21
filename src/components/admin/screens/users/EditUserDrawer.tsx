import { useEffect, useId, useState, type FormEvent } from 'react';
import { adminFetch, describeError } from '@/lib/admin/client';
import { ROLES, type Role } from '@/lib/auth/types';
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '@/lib/authz/capLabels';
import { formatDateTime, relTime } from '@/lib/admin/relTime';
import { OWNER_PROTECTED, canResetTwoStep, personName, type UserRow } from '@/lib/admin/userModel';
import Drawer from '@/components/admin/kit/Drawer';
import Modal from '@/components/admin/kit/Modal';
import Avatar from '@/components/admin/kit/Avatar';
import Note from '@/components/admin/kit/Note';
import { Badge } from '@/components/admin/kit/StatusBadge';

// The edit drawer (Admin v2 U12a, the prototype's opsEditUser without its personal access:
// roles are fixed, deviations register). Name, role and "Can sign in", the warning that a
// change signs the person out on every device, "Remove access" (confirmed) and, for the
// account owner looking at another active Admin, "Make account owner" (confirmed). The
// e-mail is shown, never edited (a change needs delivery and confirmation). The server
// decides everything again: your own role and access are refused, the owner is refused.
// Since U17: the subline says whether the person uses 2FA, and "Reset 2FA" (confirmed) clears
// a colleague's authenticator app and signs them out everywhere (never yours, never the
// owner's: the route and public.reset_two_step refuse both).

export interface EditUserDrawerProps {
  user: UserRow | null;
  selfId: string;
  /** The signed-in Admin is the account owner. */
  viewerOwns: boolean;
  onClose: () => void;
  /** A change landed: what to say, and whether ownership moved. */
  onChanged: (message: string, change?: { transferred?: boolean }) => void;
}

type Confirm = 'remove' | 'owner' | 'two-step' | null;

interface PatchAnswer {
  signedOut?: boolean;
}

export default function EditUserDrawer({
  user,
  selfId,
  viewerOwns,
  onClose,
  onChanged,
}: EditUserDrawerProps) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('content_creator');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<Confirm>(null);
  const formId = useId();
  const nameId = useId();
  const roleId = useId();
  const roleHintId = useId();
  const activeId = useId();
  const lockedHintId = useId();

  useEffect(() => {
    if (!user) return;
    setName(user.displayName ?? '');
    setRole(user.role);
    setActive(user.isActive);
    setBusy(false);
    setError('');
    setConfirm(null);
  }, [user]);

  const isSelf = user !== null && user.id === selfId;
  const locked = user !== null && (isSelf || user.isOwner);
  const roleChanged = user !== null && role !== user.role;
  const switchingOff = user !== null && user.isActive && !active;
  const canRemove = user !== null && !isSelf && !user.isOwner && user.isActive;
  const canMakeOwner =
    user !== null &&
    viewerOwns &&
    !isSelf &&
    !user.isOwner &&
    user.role === 'admin' &&
    user.status === 'active';
  const canReset = user !== null && canResetTwoStep(user, selfId);
  const shown = user ? personName(user) : '';

  async function patch(body: Record<string, unknown>): Promise<PatchAnswer> {
    return adminFetch<PatchAnswer>(`/api/admin/users/${user?.id ?? ''}`, { method: 'PATCH', body });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!user) return;
    const body: Record<string, unknown> = {};
    const trimmed = name.trim();
    if (trimmed !== (user.displayName ?? '')) body['displayName'] = trimmed === '' ? null : trimmed;
    if (!locked && role !== user.role) body['role'] = role;
    if (!locked && active !== user.isActive) body['isActive'] = active;
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setError('');
    try {
      const answer = await patch(body);
      onChanged(
        answer.signedOut
          ? `Saved. ${shown} is signed out on every device and signs in again with the new access.`
          : 'Saved.',
      );
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  async function removeAccess() {
    if (!user) return;
    setBusy(true);
    setError('');
    try {
      await patch({ isActive: false });
      setConfirm(null);
      onChanged(`${shown} can no longer sign in, and is signed out on every device.`);
    } catch (err) {
      setConfirm(null);
      setError(describeError(err));
      setBusy(false);
    }
  }

  async function resetTwoStep() {
    if (!user) return;
    setBusy(true);
    setError('');
    try {
      await adminFetch(`/api/admin/users/${user.id}/two-step-reset`, { method: 'POST' });
      setConfirm(null);
      onChanged(`2FA reset. ${shown} is signed out.`);
    } catch (err) {
      setConfirm(null);
      setError(describeError(err));
      setBusy(false);
    }
  }

  async function makeOwner() {
    if (!user) return;
    setBusy(true);
    setError('');
    try {
      await adminFetch(`/api/admin/users/${user.id}/owner`, { method: 'POST' });
      setConfirm(null);
      onChanged(`${shown} is now the account owner.`, { transferred: true });
    } catch (err) {
      setConfirm(null);
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <>
      <Drawer
        open={user !== null}
        onClose={onClose}
        title="Edit user"
        dismissible={false}
        footer={
          <div className="users-drawer__acts">
            {canRemove && (
              <button
                type="button"
                data-variant="danger"
                disabled={busy}
                onClick={() => setConfirm('remove')}
              >
                Remove access
              </button>
            )}
            {canReset && (
              <button
                type="button"
                data-variant="danger"
                disabled={busy}
                onClick={() => setConfirm('two-step')}
              >
                Reset 2FA
              </button>
            )}
            {canMakeOwner && (
              <button
                type="button"
                data-variant="soft"
                disabled={busy}
                onClick={() => setConfirm('owner')}
              >
                Make account owner
              </button>
            )}
            <button type="submit" form={formId} data-variant="primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        }
      >
        {user && (
          <form id={formId} onSubmit={(event) => void save(event)} noValidate>
            <div className="users-who">
              <Avatar
                name={user.displayName}
                email={user.email ?? ''}
                toneKey={user.id}
                size="lg"
              />
              <div>
                <p className="users-who__name" dir="auto">
                  {shown}
                  {isSelf && <span className="users-person__you"> (you)</span>}
                </p>
                {user.email && (
                  <p className="cell-secondary" dir="ltr">
                    {user.email}
                  </p>
                )}
                <p className="cell-secondary">
                  {user.lastSignInAt ? (
                    <>
                      Last signed in{' '}
                      <time dateTime={user.lastSignInAt} title={formatDateTime(user.lastSignInAt)}>
                        {relTime(user.lastSignInAt)}
                      </time>
                    </>
                  ) : (
                    'Not signed in yet'
                  )}
                  {user.twoStep !== null && (user.twoStep ? ' · 2FA on' : ' · 2FA off')}
                </p>
              </div>
            </div>

            {user.isOwner && (
              <Note tone="info">
                <p>
                  <Badge tone="klein" plain>
                    Account owner
                  </Badge>
                </p>
                <p>{OWNER_PROTECTED}</p>
              </Note>
            )}

            <div className="field">
              <label htmlFor={nameId}>Name</label>
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
              <label htmlFor={roleId}>Role</label>
              <select
                id={roleId}
                value={role}
                disabled={locked}
                aria-describedby={locked ? `${roleHintId} ${lockedHintId}` : roleHintId}
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
            <label className="field field-inline" htmlFor={activeId}>
              <input
                id={activeId}
                type="checkbox"
                checked={active}
                disabled={locked}
                aria-describedby={locked ? lockedHintId : undefined}
                onChange={(event) => setActive(event.target.checked)}
              />
              <span>Can sign in</span>
            </label>
            {locked && (
              <p className="admin-sub" id={lockedHintId}>
                {isSelf
                  ? 'You cannot change your own role or switch yourself off.'
                  : 'The account owner keeps the Admin role and can always sign in.'}
              </p>
            )}

            {(roleChanged || switchingOff) && (
              <Note tone="warn">
                {switchingOff
                  ? 'They are signed out and cannot sign in again until you re-enable them.'
                  : 'A role change signs them out on every device.'}
              </Note>
            )}
            {error && (
              <Note tone="err" role="alert">
                {error}
              </Note>
            )}
          </form>
        )}
      </Drawer>

      <Modal
        open={confirm === 'remove'}
        onClose={() => setConfirm(null)}
        title={`Remove access for ${shown}?`}
        sub="They are signed out and cannot sign in again until you re-enable them."
        dismissible={false}
        footer={
          <>
            <button type="button" data-autofocus="" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              type="button"
              data-variant="danger"
              disabled={busy}
              onClick={() => void removeAccess()}
            >
              Remove access
            </button>
          </>
        }
      >
        <p>Their account and everything they made stay. You can switch Can sign in back on.</p>
      </Modal>

      <Modal
        open={confirm === 'two-step'}
        onClose={() => setConfirm(null)}
        title={`Reset 2FA for ${shown}?`}
        sub="Their authenticator app stops working here and they are signed out everywhere."
        dismissible={false}
        footer={
          <>
            <button type="button" data-autofocus="" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              type="button"
              data-variant="danger"
              disabled={busy}
              onClick={() => void resetTwoStep()}
            >
              Reset 2FA
            </button>
          </>
        }
      >
        <p>
          They set 2FA up again the next time they sign in if your team requires it, or from their
          account. This is recorded in the activity log.
        </p>
      </Modal>

      <Modal
        open={confirm === 'owner'}
        onClose={() => setConfirm(null)}
        title={`Make ${shown} the account owner?`}
        sub="The account owner keeps the Admin role, and only they can hand ownership on."
        dismissible={false}
        footer={
          <>
            <button type="button" data-autofocus="" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              type="button"
              data-variant="primary"
              disabled={busy}
              onClick={() => void makeOwner()}
            >
              Make account owner
            </button>
          </>
        }
      >
        <p>You stay an Admin. This is recorded in the activity log.</p>
      </Modal>
    </>
  );
}
