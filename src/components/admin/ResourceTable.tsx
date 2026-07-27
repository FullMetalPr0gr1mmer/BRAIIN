import { useCallback, useEffect, useState } from 'react';
import { adminFetch, describeError } from '@/lib/admin/client';
import { uiFor, type ColumnDef } from '@/lib/admin/uiSchema';

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
    if (!window.confirm(`Delete this ${ui.singular.toLowerCase()}? This cannot be undone.`)) return;
    setError('');
    try {
      await adminFetch(`/api/admin/${ui.slug}/${row.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
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
