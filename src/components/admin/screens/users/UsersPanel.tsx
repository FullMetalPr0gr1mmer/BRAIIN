import { useCallback, useEffect, useState } from 'react';
import { adminFetch, describeError } from '@/lib/admin/client';
import { ROLE_LABELS } from '@/lib/authz/capLabels';
import { useClock } from '@/components/admin/kit/clock';
import { STATUS_LABEL, personName, type UserRow, type UserStatus } from '@/lib/admin/userModel';
import type { BadgeTone } from '@/lib/admin/tones';
import DataTable, { type DataColumn } from '@/components/admin/kit/DataTable';
import Avatar from '@/components/admin/kit/Avatar';
import Note from '@/components/admin/kit/Note';
import { Badge } from '@/components/admin/kit/StatusBadge';
import EditUserDrawer from './EditUserDrawer';
import InviteDrawer from './InviteDrawer';
import PendingInvites from './PendingInvites';
import SecurityCard from './SecurityCard';

// Users & roles (Admin v2 U12a, ui.md AV-21; `users.manage`, Admin only). Built on the kit:
// the people table (DataTable), the edit drawer (Drawer, with Modal confirms), Pending
// invites with Resend and Cancel and the invite drawer (U12b; "Not set up" while the site
// cannot send e-mail) and the Security card. The read-only role matrix is server-rendered by
// the page beside this island.
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
  /**
   * The site can send e-mail (AUTH_EMAIL_READY, owner items O-2 and O-22): invites and
   * resends are offered. Off, they say "Not set up" (the API answers 503 the same).
   */
  emailReady: boolean;
}

interface Page {
  rows: UserRow[];
  total: number;
  /** null: unknown (the directory could not be read), so nothing is said about it. */
  hasOwner: boolean | null;
  /** Every invite nobody has accepted yet, wherever it falls in the pages (U12b). */
  pending: UserRow[];
  /** Active members without 2FA, across the directory (U17); null when unknown. */
  withoutTwoStep: number | null;
}

const STATUS_TONE: Readonly<Record<UserStatus, BadgeTone>> = {
  active: 'ok',
  removed: 'gray',
  locked: 'err',
  invited: 'sky',
};

export default function UsersPanel({ selfId, isOwner, canManage, emailReady }: UsersPanelProps) {
  const { formatDateTime, relTime } = useClock();
  const [page, setPage] = useState<Page>({
    rows: [],
    total: 0,
    hasOwner: true,
    pending: [],
    withoutTwoStep: null,
  });
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [viewerOwns, setViewerOwns] = useState(isOwner);
  const [inviting, setInviting] = useState(false);

  const load = useCallback(
    async (at: number) => {
      setBusy(true);
      setError(undefined);
      try {
        const data = await adminFetch<Page>(`/api/admin/users?limit=25&offset=${at}`);
        setPage({
          rows: data.rows ?? [],
          total: data.total ?? 0,
          hasOwner: typeof data.hasOwner === 'boolean' ? data.hasOwner : null,
          pending: Array.isArray(data.pending) ? data.pending : [],
          withoutTwoStep: typeof data.withoutTwoStep === 'number' ? data.withoutTwoStep : null,
        });
        // Whether the viewer owns the account, as fresh as the list: the page's prop is the
        // server's answer at render time, and ownership may have moved since.
        const me = (data.rows ?? []).find((row) => row.id === selfId);
        if (me) setViewerOwns(me.isOwner);
      } catch (err) {
        setError(describeError(err));
      } finally {
        setBusy(false);
      }
    },
    [selfId],
  );

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
      // The prototype's "2FA" column (screens_ops.js), after Role (U17).
      key: 'twoStep',
      label: '2FA',
      render: (row) =>
        row.twoStep === null ? (
          <span className="cell-secondary">Unknown</span>
        ) : row.twoStep ? (
          <Badge tone="ok">On</Badge>
        ) : (
          <Badge tone="warn">Off</Badge>
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
      {!busy && !error && page.hasOwner === false && (
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
        empty={{
          title: 'Nobody here yet',
          text: 'Invite someone from Pending invites below.',
          icon: 'users',
        }}
      />
      {canManage && (
        <div className="grid grid--2-1 users-cards">
          <PendingInvites
            pending={page.pending}
            emailReady={emailReady}
            onInvite={() => {
              setNotice('');
              setInviting(true);
            }}
            onChanged={(message) => {
              setNotice(message);
              void load(offset);
            }}
          />
          <SecurityCard withoutTwoStep={page.withoutTwoStep} />
        </div>
      )}
      {canManage && emailReady && (
        <InviteDrawer
          open={inviting}
          onClose={() => setInviting(false)}
          onInvited={(email) => {
            setInviting(false);
            setNotice(`Invite sent to ${email}.`);
            void load(offset);
          }}
        />
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
