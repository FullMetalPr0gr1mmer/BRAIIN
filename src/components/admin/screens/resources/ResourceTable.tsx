import { useCallback, useEffect, useState } from 'react';
import { adminFetch, describeError } from '@/lib/admin/client';
import { confirmDialog } from '@/lib/admin/confirm';
import { toast } from '@/lib/admin/toast';
import { uiFor, type ColumnDef, type SyncActionDef } from '@/lib/admin/uiSchema';

// The list view for every CRUD resource. Reads its shape from RESOURCE_UI, so adding an
// entity is a config entry rather than a component.
//
// Note what the delete button does NOT do: it never checks the caller's role to decide
// whether to render. The server answers `content.archiveDelete` (Admin-only), and a
// non-admin who clicks gets a 403 rendered as a message. Hiding it would be nicer UX;
// hiding it *instead of* the server check is the bug CLAUDE.md calls out by name, and
// mixing the two invites someone to later "simplify" by keeping only the visible half.

interface Row extends Record<string, unknown> {
  id: string;
  version: number;
}

interface ListResponse {
  rows: Row[];
  total: number;
  limit: number;
  offset: number;
}

export interface ResourceTableProps {
  resource: string;
  /** Extra query string appended to the list call (e.g. `page_id=…` for sections). */
  filter?: string;
}

const PAGE_SIZE = 25;

export default function ResourceTable({ resource, filter = '' }: ResourceTableProps) {
  const ui = uiFor(resource);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  // Bumped after every delete so the edge status line re-reads (a delete rebuilds the
  // snapshot server-side; the line must not keep showing the old count).
  const [syncEpoch, setSyncEpoch] = useState(0);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (status) params.set('status', status);
      if (query) params.set('q', query);
      const suffix = filter ? `&${filter}` : '';
      const data = await adminFetch<ListResponse>(
        `/api/admin/${ui.slug}?${params.toString()}${suffix}`,
      );
      setRows(data.rows ?? []);
      setTotal(data.total ?? 0);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [ui.slug, offset, status, query, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(row: Row) {
    // A real <dialog>, not window.confirm: the browser can suppress repeated native
    // confirms wholesale, at which point destructive actions silently resolve one way
    // or the other. confirmDialog puts initial focus on Cancel.
    const confirmed = await confirmDialog({
      message: `Delete this ${ui.singular.toLowerCase()}? This cannot be undone.`,
      confirmLabel: 'Delete',
    });
    if (!confirmed) return;
    setError('');
    try {
      const result = await adminFetch<{ kvSynced?: boolean }>(`/api/admin/${ui.slug}/${row.id}`, {
        method: 'DELETE',
      });
      toast(`${ui.singular} deleted.`, 'ok');
      if (result.kvSynced === false) setError(EDGE_NOT_SYNCED);
      setSyncEpoch((n) => n + 1);
      await load();
    } catch (err) {
      // Errors stay inline, never in a toast — they must not auto-dismiss.
      setError(describeError(err));
    }
  }

  async function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    const a = rows[index];
    const b = rows[target];
    if (!a || !b) return;
    setError('');
    try {
      // Swaps the two rows' sort_order. One round-trip, and the server applies both in
      // the same tenant-scoped loop, so a half-applied reorder is not reachable.
      await adminFetch(`/api/admin/${ui.slug}/reorder`, {
        method: 'POST',
        body: {
          items: [
            { id: a.id, sortOrder: Number(b['sort_order'] ?? target) },
            { id: b.id, sortOrder: Number(a['sort_order'] ?? index) },
          ],
        },
      });
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <div>
      <div className="toolbar">
        <a className="btn" data-variant="primary" href={`/admin/${ui.slug}/new`}>
          New {ui.singular.toLowerCase()}
        </a>
        <label className="visually-hidden" htmlFor={`${ui.slug}-search`}>
          Search {ui.title}
        </label>
        <input
          id={`${ui.slug}-search`}
          type="text"
          placeholder="Search…"
          value={query}
          onChange={(event) => {
            setOffset(0);
            setQuery(event.target.value);
          }}
        />
        {ui.hasStatus && (
          <>
            <label className="visually-hidden" htmlFor={`${ui.slug}-status`}>
              Filter by status
            </label>
            <select
              id={`${ui.slug}-status`}
              value={status}
              onChange={(event) => {
                setOffset(0);
                setStatus(event.target.value);
              }}
            >
              <option value="">All statuses</option>
              <option value="draft">Draft</option>
              <option value="scheduled">Scheduled</option>
              <option value="published">Published</option>
              <option value="archived">Archived</option>
            </select>
          </>
        )}
      </div>

      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}

      {ui.syncAction && <SyncStatus action={ui.syncAction} epoch={syncEpoch} />}

      <div className="card table-wrap">
        <table className="data">
          <caption className="visually-hidden">{ui.title}</caption>
          <thead>
            <tr>
              {ui.columns.map((column) => (
                <th key={column.key} scope="col">
                  {column.label}
                </th>
              ))}
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.id}>
                {ui.columns.map((column) => (
                  <td key={column.key}>{renderCell(row[column.key], column)}</td>
                ))}
                <td>
                  <a className="btn" href={`/admin/${ui.slug}/${row.id}`}>
                    Edit
                  </a>{' '}
                  {ui.reorder && (
                    <>
                      <button
                        type="button"
                        onClick={() => void move(index, -1)}
                        disabled={index === 0}
                        aria-label="Move up"
                      >
                        ↑
                      </button>{' '}
                      <button
                        type="button"
                        onClick={() => void move(index, 1)}
                        disabled={index === rows.length - 1}
                        aria-label="Move down"
                      >
                        ↓
                      </button>{' '}
                    </>
                  )}
                  <button type="button" data-variant="danger" onClick={() => void remove(row)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && !busy && (
              <tr>
                <td colSpan={ui.columns.length + 1}>No {ui.title.toLowerCase()} yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="toolbar form-actions">
        <button
          type="button"
          onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          disabled={offset === 0}
        >
          Previous
        </button>
        <span aria-live="polite">
          {total === 0 ? '0' : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)}`} of {total}
        </span>
        <button
          type="button"
          onClick={() => setOffset(offset + PAGE_SIZE)}
          disabled={offset + PAGE_SIZE >= total}
        >
          Next
        </button>
      </div>
    </div>
  );
}

/**
 * The maintenance panel's wording (MaintenancePanel.tsx), reused: the row is committed,
 * the edge snapshot is not, and the operator must act — never a silent 200.
 */
export const EDGE_NOT_SYNCED =
  'Saved to the database, but the edge did not pick it up. The site is still serving the previous rules — retry with “Sync to edge” before relying on this.';

interface SyncStatusProps {
  action: SyncActionDef;
  /** Any change bumps it and the counts are re-read. */
  epoch: number;
}

/**
 * "Sync to edge" and the status line beside it. The table is the source of truth, the
 * snapshot is what the public request path reads (Round 3, design-port R3-1); this is
 * the one place the two are compared, so an operator can see "12 in the database, none
 * at the edge" after a deploy and fix it with one click (runbook §6f).
 */
function SyncStatus({ action, epoch }: SyncStatusProps) {
  const [counts, setCounts] = useState<{ db: number; edge: number | null } | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setCounts(await adminFetch<{ db: number; edge: number | null }>(action.endpoint));
    } catch (err) {
      setError(describeError(err));
    }
  }, [action.endpoint]);

  useEffect(() => {
    void refresh();
  }, [refresh, epoch]);

  async function sync() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await adminFetch<{ kvSynced: boolean; count: number; truncated: boolean }>(
        action.endpoint,
        { method: 'POST' },
      );
      await refresh();
      if (!result.kvSynced) setError(EDGE_NOT_SYNCED);
      else
        setNotice(
          `${result.count} rule${result.count === 1 ? '' : 's'} live at the edge.` +
            (result.truncated ? ' The table holds more rules than one snapshot carries.' : ''),
        );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="toolbar" data-sync>
      <button type="button" onClick={() => void sync()} disabled={busy}>
        {action.label}
      </button>
      <span className="admin-sub" aria-live="polite">
        {counts === null
          ? 'Edge status unknown.'
          : counts.edge === null
            ? `${counts.db} in the database · nothing at the edge yet — sync to make the rules live.`
            : counts.db === counts.edge
              ? `${counts.db} in the database · ${counts.edge} at the edge.`
              : `${counts.db} in the database · ${counts.edge} at the edge — out of step, sync.`}
      </span>
      {notice && (
        <span className="msg" data-kind="ok" role="status">
          {notice}
        </span>
      )}
      {error && (
        <span className="msg" data-kind="error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function renderCell(value: unknown, column: ColumnDef) {
  if (value === null || value === undefined) return '—';
  switch (column.kind) {
    case 'status':
      return (
        <span className="badge" data-status={String(value)}>
          {String(value)}
        </span>
      );
    case 'date':
      return new Date(String(value)).toLocaleDateString();
    case 'boolean':
      return value ? 'Yes' : 'No';
    case 'bilingual': {
      const record = value as Record<string, unknown>;
      const en = typeof record['en'] === 'string' ? record['en'] : '';
      const ar = typeof record['ar'] === 'string' ? record['ar'] : '';
      return (
        <>
          <div>{en || <em>no English</em>}</div>
          {/* dir="rtl" on the Arabic cell only — a mixed table where the Arabic column
              renders LTR shows correct characters with the punctuation in the wrong
              place, which reviewers reliably miss. */}
          <div dir="rtl" lang="ar" className="cell-secondary">
            {ar || <em>no Arabic</em>}
          </div>
        </>
      );
    }
    default:
      return String(value);
  }
}
