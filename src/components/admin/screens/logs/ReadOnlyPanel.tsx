import { useCallback, useEffect, useState } from 'react';
import { adminFetch, describeError } from '@/lib/admin/client';

// The system logs (/admin/logs): a read-only table with a level filter and, for Admin, the
// "clear" control. The activity log had a variant of this panel until Admin v2 U13 made
// /admin/audit a server-rendered page (src/pages/admin/audit.astro), with its chain check in
// src/lib/admin/activity.ts.

interface Row extends Record<string, unknown> {
  id: number | string;
}

interface Response {
  rows: Row[];
  total: number;
}

export interface ReadOnlyPanelProps {
  endpoint: string;
  columns: { key: string; label: string; kind?: 'date' | 'json' | 'text' }[];
  /** The one variant left, as /admin/logs still names it (the page is U2's to rewrite). */
  variant?: 'logs';
  /** Enables the Admin-only "clear" control. */
  canClear?: boolean;
}

const PAGE_SIZE = 50;

export default function ReadOnlyPanel({ endpoint, columns, canClear = false }: ReadOnlyPanelProps) {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [level, setLevel] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (level) params.set('level', level);
      const data = await adminFetch<Response>(`${endpoint}?${params.toString()}`);
      setRows(data.rows ?? []);
      setTotal(data.total ?? 0);
    } catch (err) {
      setError(describeError(err));
    }
  }, [endpoint, offset, level]);

  useEffect(() => {
    void load();
  }, [load]);

  async function clear() {
    if (!window.confirm('Clear system logs older than 30 days? The audit log is unaffected.'))
      return;
    try {
      await adminFetch(`${endpoint}?olderThanDays=30`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <div>
      <div className="toolbar">
        <label className="visually-hidden" htmlFor="log-level">
          Filter by level
        </label>
        <select
          id="log-level"
          value={level}
          onChange={(event) => {
            setOffset(0);
            setLevel(event.target.value);
          }}
        >
          <option value="">All levels</option>
          <option value="error">error</option>
          <option value="warn">warn</option>
          <option value="info">info</option>
          <option value="debug">debug</option>
        </select>
        {canClear && (
          <button type="button" data-variant="danger" onClick={() => void clear()}>
            Clear logs older than 30 days
          </button>
        )}
      </div>

      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}

      <div className="card table-wrap">
        <table className="data">
          <caption className="visually-hidden">System logs</caption>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} scope="col">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={String(row.id)}>
                {columns.map((column) => (
                  <td key={column.key}>{renderCell(row[column.key], column.kind)}</td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length}>Nothing recorded.</td>
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

function renderCell(value: unknown, kind?: 'date' | 'json' | 'text') {
  if (value === null || value === undefined) return '—';
  if (kind === 'date') return new Date(String(value)).toLocaleString();
  if (kind === 'json') {
    const text = JSON.stringify(value);
    // Truncated: `detail` blobs are occasionally large, and one wide cell forces the
    // whole table into horizontal scroll for every other row.
    return text.length > 160 ? `${text.slice(0, 160)}…` : text;
  }
  return String(value);
}
