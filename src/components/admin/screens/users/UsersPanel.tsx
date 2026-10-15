import { useCallback, useEffect, useState } from 'react';
import { adminFetch, describeError } from '@/lib/admin/client';
import { ROLE_LABELS } from '@/lib/authz/capLabels';
import { formatDateTime, relTime } from '@/lib/admin/relTime';
import { STATUS_LABEL, personName, type UserRow, type UserStatus } from '@/lib/admin/userModel';
import type { BadgeTone } from '@/lib/admin/tones';
import DataTable, { type DataColumn } from '@/components/admin/kit/DataTable';
import Avatar from '@/components/admin/kit/Avatar';
import Note from '@/components/admin/kit/Note';
import { Badge } from '@/components/admin/kit/StatusBadge';
import EditUserDrawer from './EditUserDrawer';
import InviteCard from './InviteCard';
import SecurityCard from './SecurityCard';

// Users & roles (Admin v2 U12a, ui.md AV-21; `users.manage`, Admin only). Built on the kit:
// the people table (DataTable), the edit drawer (Drawer, with Modal confirms), the invite
// card (today's invite; U12b replaces it with the invite drawer and pending invites) and the
// Security card. The read-only role matrix is server-rendered by the page beside this island.
//
// What a change does, said where it is made: a role change or switching someone off ends
// every sign-in that person has, on every device (0055 deletes their sessions; the admin
// turns them away at their next click). The account owner keeps the Admin role.

export interface UsersPanelProps {
  /** The signed-in Admin's id: self-demotion and self-deactivation are refused. */
  selfId: string;
  /** Whether the signed-in Admin is the account owner (who alone can hand it on). */
  isOwner: boolean;
  /**
   * The viewer holds `users.manage` (the server's answer, from ROLE_CAPS). Without it the
   * screen is the table alone, which shows the API's refusal (CLAUDE.md §9, refusals e2e).
   */
  canManage: boolean;
}

interface Page {
  rows: UserRow[];
  total: number;
  hasOwner: boolean;
}

const STATUS_TONE: Readonly<Record<UserStatus, BadgeTone>> = {
  active: 'ok',
  removed: 'gray',
  locked: 'err',
  invited: 'sky',
};

export default function UsersPanel({ selfId, isOwner, canManage }: UsersPanelProps) {
  const [page, setPage] = useState<Page>({ rows: [], total: 0, hasOwner: true });
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [viewerOwns, setViewerOwns] = useState(isOwner);

  const load = useCallback(async (at: number) => {
    setBusy(true);
    setError(undefined);
    try {
      const data = await adminFetch<Page>(`/api/admin/users?limit=25&offset=${at}`);
      setPage({ rows: data.rows ?? [], total: data.total ?? 0, hasOwner: data.hasOwner !== false });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(offset);
  }, [load, offset]);

  const columns: readonly DataColumn<UserRow>[] = [
    {
      key: 'person',
      label: 'Person',
      render: (row) => (
        <span className="users-person">
          <Avatar name={row.displayName} email={row.email ?? ''} toneKey={row.id} size="sm" />
          <span className="users-person__who">
            <span className="users-person__name" dir="auto">
              {personName(row)}
              {row.id === selfId && <span className="users-person__you"> (you)</span>}
            </span>
            {row.email && row.displayName && (
              <span className="cell-secondary" dir="ltr">
                {row.email}
              </span>
            )}
          </span>
        </span>
      ),
    },
    {
      key: 'role',
      label: 'Role',
      render: (row) => (
        <span className="users-badges">
          <Badge tone={row.role === 'admin' ? 'sky' : 'gray'} plain>
            {ROLE_LABELS[row.role]}
          </Badge>
          {row.isOwner && (
            <Badge tone="klein" plain>
              Account owner
            </Badge>
          )}
        </span>
      ),
    },
    {
      key: 'status',
      label: 'Access',
      render: (row) => <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>,
    },
    {
      key: 'lastSignInAt',
      label: 'Last sign-in',
      render: (row) =>
        row.lastSignInAt ? (
          <time dateTime={row.lastSignInAt} title={formatDateTime(row.lastSignInAt)}>
            {relTime(row.lastSignInAt)}
          </time>
        ) : (
          'Never'
        ),
    },
  ];

  return (
    <div className="users">
      {notice && (
        <Note tone="ok" role="status">
          {notice}
        </Note>
      )}
      {!busy && !error && !page.hasOwner && (
        <Note tone="warn">
          No account owner is set yet. Ask whoever runs the database to mark it (launch runbook §3).
        </Note>
      )}
      <DataTable
        caption="People who can use the admin"
        columns={columns}
        rows={page.rows}
        rowName={personName}
        total={page.total}
        offset={offset}
        onPage={setOffset}
        busy={busy}
        error={error}
        actionsLabel="Edit"
        rowActions={
          canManage
            ? (row) => (
                <button
                  type="button"
                  data-size="sm"
                  data-variant="ghost"
                  aria-label={`Edit ${personName(row)}`}
                  onClick={() => {
                    setNotice('');
                    setEditing(row);
                  }}
                >
                  Edit
                </button>
              )
            : undefined
        }
        empty={{ title: 'Nobody here yet', text: 'Invite someone below.', icon: 'users' }}
      />
      {canManage && (
        <div className="grid grid--2-1 users-cards">
          <InviteCard onInvited={() => void load(offset)} />
          <SecurityCard />
        </div>
      )}
      <EditUserDrawer
        user={editing}
        selfId={selfId}
        viewerOwns={viewerOwns}
        onClose={() => setEditing(null)}
        onChanged={(message, change) => {
          setNotice(message);
          if (change?.transferred) setViewerOwns(false);
          setEditing(null);
          void load(offset);
        }}
      />
    </div>
  );
}
