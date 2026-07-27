import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { adminFetch, describeError } from '@/lib/admin/client';

// Users & roles — Admin only (`users.manage`).
//
// The copy under the role selector is doing real work: changing someone's role rewrites
// their JWT claim AND their profile row, and `resolveAuthContext` kills any session
// where those two disagree. So a role change signs the person out. That is the correct
// behaviour (it is what makes a demotion take effect against RLS immediately) but it is
// surprising if nobody says so, and the admin who does it should not have to discover
// it from a colleague's confused message.

interface UserRow {
  id: string;
  role: string;
  is_active: boolean;
  display_name: string | null;
  locked_until: string | null;
  last_login_at: string | null;
  created_at: string;
}

const ROLES = ['admin', 'content_creator', 'seo', 'developer'] as const;

export interface UsersPanelProps {
  /** The signed-in admin's id — used to disable self-demotion in the UI. */
  selfId: string;
}

export default function UsersPanel({ selfId }: UsersPanelProps) {
  const [rows, setRows] = useState<UserRow[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<string>('content_creator');

  const load = useCallback(async () => {
    setError('');
    try {
      const data = await adminFetch<{ rows: UserRow[] }>('/api/admin/users?limit=100');
      setRows(data.rows ?? []);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function invite(event: FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    try {
      await adminFetch('/api/admin/users', {
        method: 'POST',
        body: { email: inviteEmail, role: inviteRole },
      });
      setNotice(`Invitation sent to ${inviteEmail}.`);
      setInviteEmail('');
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function update(id: string, body: Record<string, unknown>) {
    setError('');
    setNotice('');
    try {
      await adminFetch(`/api/admin/users/${id}`, { method: 'PATCH', body });
      setNotice('Updated. If you changed a role, that person will need to sign in again.');
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <div>
      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="msg" data-kind="ok" role="status">
          {notice}
        </p>
      )}

      <form className="card" onSubmit={(event) => void invite(event)}>
        <h2 className="card-title">Invite a colleague</h2>
        <div className="row-2">
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              required
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Role</span>
            <select value={inviteRole} onChange={(event) => setInviteRole(event.target.value)}>
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {role.replace('_', ' ')}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button type="submit" data-variant="primary">
          Send invitation
        </button>
      </form>

      <div className="card table-wrap">
        <table className="data">
          <caption className="visually-hidden">Users and roles</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Role</th>
              <th scope="col">Active</th>
              <th scope="col">Last sign-in</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isSelf = row.id === selfId;
              const locked = row.locked_until !== null && Date.parse(row.locked_until) > Date.now();
              return (
                <tr key={row.id}>
                  <td>
                    {row.display_name ?? row.id.slice(0, 8)}
                    {isSelf && <span className="badge"> you</span>}
                    {locked && (
                      <span className="badge" data-status="archived">
                        {' '}
                        locked
                      </span>
                    )}
                  </td>
                  <td>
                    <label className="visually-hidden" htmlFor={`r-${row.id}`}>
                      Role
                    </label>
                    <select
                      id={`r-${row.id}`}
                      value={row.role}
                      disabled={isSelf}
                      onChange={(event) => void update(row.id, { role: event.target.value })}
                    >
                      {ROLES.map((role) => (
                        <option key={role} value={role}>
                          {role.replace('_', ' ')}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>{row.is_active ? 'Yes' : 'No'}</td>
                  <td>{row.last_login_at ? new Date(row.last_login_at).toLocaleString() : '—'}</td>
                  <td>
                    {/* Disabled for yourself: users.manage is Admin-only, so a lone
                        admin who deactivates themselves leaves nobody who can undo it. */}
                    <button
                      type="button"
                      data-variant={row.is_active ? 'danger' : undefined}
                      disabled={isSelf}
                      onClick={() => void update(row.id, { isActive: !row.is_active })}
                    >
                      {row.is_active ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="admin-sub">
        Changing a role rewrites the person’s access token claim and their profile row together.
        Their current session stops working immediately — that is what makes a demotion effective
        against the database, not just the interface.
      </p>
    </div>
  );
}
