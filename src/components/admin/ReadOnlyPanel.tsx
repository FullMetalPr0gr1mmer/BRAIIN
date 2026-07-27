import { useCallback, useEffect, useState } from 'react';
import { adminFetch, describeError } from '@/lib/admin/client';

// Read-only tabular views: system logs and the audit log.
//
// The audit variant renders a chain-integrity banner from the `chain` field the API
// returns. It is worth being precise about what that banner proves and what it does
// not: the server checked that each row's `prev_hash` matches its predecessor's `hash`,
// which detects DELETED or REORDERED entries. It cannot detect a rewritten row, because
// recomputing a hash needs the Vault key that only the insert trigger's definer can
// read. Full tamper detection is the hourly R2-anchor verifier's job (CLAUDE.md §10) —
// this is the cheap check that runs on every page view, not a replacement for it.

interface Row extends Record<string, unknown> {
  id: number | string;
}

interface Response {
  rows: Row[];
  total: number;
  chain?: { contiguous: boolean; brokenAt: number | null };
}

export interface ReadOnlyPanelProps {
  endpoint: string;
  columns: { key: string; label: string; kind?: 'date' | 'json' | 'text' }[];
  /** Renders the audit chain banner and hides the level filter. */
  variant?: 'logs' | 'audit';
  /** Enables the Admin-only "clear" control (logs only). */
  canClear?: boolean;
}

const PAGE_SIZE = 50;

export default function ReadOnlyPanel({
  endpoint,
  columns,
  variant = 'logs',
  canClear = false,
}: ReadOnlyPanelProps) {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [level, setLevel] = useState('');
  const [chain, setChain] = useState<Response['chain']>(undefined);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (level) params.set('level', level);
      const data = await adminFetch<Response>(`${endpoint}?${params.toString()}`);
      setRows(data.rows ?? []);
      setTotal(data.total ?? 0);
      setChain(data.chain);
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
        {variant === 'logs' && (
          <>
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
          </>
        )}
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

      {variant === 'audit' && chain && (
        <p className="msg" data-kind={chain.contiguous ? 'ok' : 'error'} role="status">
          {chain.contiguous
            ? 'Hash chain is contiguous across the entries on this page.'
            : `Chain break detected at entry ${chain.brokenAt}. Check the hourly anchor verifier.`}
        </p>
      )}

      <div className="card table-wrap">
        <table className="data">
          <caption className="visually-hidden">
            {variant === 'audit' ? 'Audit log' : 'System logs'}
          </caption>
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
