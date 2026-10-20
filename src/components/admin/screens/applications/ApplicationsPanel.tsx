import { useCallback, useEffect, useState } from 'react';
import { EXPERIENCE_LEVELS, optionLabel, type ApplicationStatus } from '@schemas/application';
import { adminFetch, describeError } from '@/lib/admin/client';
import { PAGE_SIZE } from '@/lib/admin/pager';
import { formatDateTime, relTime } from '@/lib/admin/relTime';
import {
  statusChips,
  statusLabel,
  statusTone,
  type ApplicationRow,
  type StatusChip,
} from '@/lib/admin/applicationView';
import Chips from '@/components/admin/kit/Chips';
import DataTable, { type DataColumn } from '@/components/admin/kit/DataTable';
import Note from '@/components/admin/kit/Note';
import { Badge } from '@/components/admin/kit/StatusBadge';
import ApplicationDrawer from './ApplicationDrawer';

// Job applications (Join), Admin only (Admin v2 U8a, ui.md AV-17), on the kit: the list is a
// DataTable with status chips and the pager, each row's "Open" shows the application in a
// wide drawer (ApplicationDrawer: the audited reveal, the CV download, status, notes,
// consent and retention, erase). The four routes are unchanged; the list and the detail
// never carry contact details or the CV's storage path (src/lib/admin/applicationFields.ts).
//
// The address keeps `?status=` and `?open=<id>` in step (history.replaceState), and the
// server reads both for the first paint (src/pages/admin/applications/index.astro), so the
// bell's "New application" opens that one. Opening writes the route's `application.view`
// audit row (no personal data), as a click does. A status changes in the drawer only (D6):
// one control per change, never from a table row.

export interface ApplicationsPanelProps {
  /** Mirrors `applications.pii`: UX only, the server decides. */
  canSeePii: boolean;
  /** The address's status filter, checked on the server; null for All. */
  initialStatus?: ApplicationStatus | null | undefined;
  /** The address's `?open=` application, checked on the server (a uuid); null for none. */
  openId?: string | null | undefined;
}

interface ListResponse {
  rows: ApplicationRow[];
  total: number;
}

/** Keeps `?status=` and `?open=` in the address, without a history entry. */
function syncAddress(status: StatusChip, open: string | null): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (status === 'all') url.searchParams.delete('status');
  else url.searchParams.set('status', status);
  if (open) url.searchParams.set('open', open);
  else url.searchParams.delete('open');
  window.history.replaceState(window.history.state, '', url);
}

export default function ApplicationsPanel({
  canSeePii,
  initialStatus = null,
  openId = null,
}: ApplicationsPanelProps) {
  const [rows, setRows] = useState<ApplicationRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState<StatusChip>(initialStatus ?? 'all');
  const [open, setOpen] = useState<string | null>(openId);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (status !== 'all') params.set('status', status);
      const data = await adminFetch<ListResponse>(`/api/admin/applications?${params.toString()}`);
      setRows(data.rows ?? []);
      setTotal(data.total ?? 0);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [offset, status]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    syncAddress(status, open);
  }, [status, open]);

  const columns: readonly DataColumn<ApplicationRow>[] = [
    { key: 'name', label: 'Name', render: (row) => <span dir="auto">{row.name}</span> },
    { key: 'role', label: 'Role', render: (row) => <span dir="auto">{row.role}</span> },
    {
      key: 'experience',
      label: 'Experience',
      render: (row) => optionLabel(EXPERIENCE_LEVELS, row.experience),
    },
    { key: 'cv', label: 'CV', render: (row) => (row.has_cv ? 'Yes' : 'No') },
    {
      key: 'created_at',
      label: 'Received',
      render: (row) => (
        <time dateTime={row.created_at} title={formatDateTime(row.created_at)}>
          {relTime(row.created_at)}
        </time>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (row) => <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>,
    },
  ];

  const filtered = status !== 'all';

  return (
    <div className="apps">
      {notice && (
        <Note tone="ok" role="status">
          {notice}
        </Note>
      )}
      <DataTable<ApplicationRow>
        caption="Job applications"
        columns={columns}
        rows={rows}
        rowName={(row) => row.name}
        total={total}
        offset={offset}
        limit={PAGE_SIZE}
        onPage={setOffset}
        busy={busy}
        error={error}
        actionsLabel="Open"
        rowActions={(row) => (
          <button
            type="button"
            data-size="sm"
            data-variant="ghost"
            aria-label={`Open ${row.name}’s application`}
            onClick={() => {
              setNotice('');
              setOpen(row.id);
            }}
          >
            Open
          </button>
        )}
        toolbar={
          <Chips<StatusChip>
            label="Filter by status"
            chips={statusChips()}
            selected={[status]}
            onChange={([next]) => {
              setOffset(0);
              setStatus(next ?? 'all');
            }}
          />
        }
        empty={
          filtered
            ? { title: 'No applications match', text: 'Try another status.', icon: 'hand' }
            : {
                title: 'No applications yet',
                text: 'They arrive here from the Join page.',
                icon: 'hand',
              }
        }
      />
      <ApplicationDrawer
        id={open}
        canSeePii={canSeePii}
        onClose={() => setOpen(null)}
        onChanged={() => void load()}
        onErased={() => {
          setOpen(null);
          setNotice('Application erased.');
          void load();
        }}
      />
    </div>
  );
}

// The panel's helpers live in the screen's model (src/lib/admin/applicationView.ts); kept
// importable from here, where tests/lib/applicationsAdmin.spec.ts has always read them.
export { formatBytes, safeLink } from '@/lib/admin/applicationView';
