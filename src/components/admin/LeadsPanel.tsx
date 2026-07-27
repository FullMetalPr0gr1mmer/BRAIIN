import { useCallback, useEffect, useState } from 'react';
import { adminFetch, describeError } from '@/lib/admin/client';

// Leads list + detail, including the one control in this CMS that reveals personal data.
//
// ── "Reveal PII" is an explicit action, not a default ────────────────────────────
// The list never carries contact details and the detail view loads without them; a
// second, deliberate click fetches `?pii=1`, and the server audits that fetch. This is
// not UI politeness — it is what makes the audit trail meaningful. If every page view
// decrypted, `lead.view_pii` would fire on idle browsing and the log would answer "who
// looked at this person's phone number" with "everyone, constantly".

interface LeadRow {
  id: string;
  name: string;
  status: string;
  service_of_interest: string | null;
  locale: string;
  created_at: string;
  message: string;
}

interface LeadDetail extends LeadRow {
  email?: string | null;
  phone?: string | null;
  budget?: string | null;
  timeline_band?: string | null;
  internal_notes?: string | null;
}

interface ListResponse {
  rows: LeadRow[];
  total: number;
}

export interface LeadsPanelProps {
  /** Mirrors the server's `leads.pii` grant — UX only; the server decides. */
  canSeePii: boolean;
  /** Mirrors `export.csv`. */
  canExport: boolean;
}

const PAGE_SIZE = 25;
const STATUSES = ['new', 'in_progress', 'done', 'spam'] as const;

export default function LeadsPanel({ canSeePii, canExport }: LeadsPanelProps) {
  const [rows, setRows] = useState<LeadRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<LeadDetail | null>(null);
  const [piiShown, setPiiShown] = useState(false);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (status) params.set('status', status);
      const data = await adminFetch<ListResponse>(`/api/admin/leads?${params.toString()}`);
      setRows(data.rows ?? []);
      setTotal(data.total ?? 0);
    } catch (err) {
      setError(describeError(err));
    }
  }, [offset, status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function open(id: string, withPii: boolean) {
    setError('');
    try {
      const detail = await adminFetch<LeadDetail>(
        `/api/admin/leads/${id}${withPii ? '?pii=1' : ''}`,
      );
      setSelected(detail);
      setPiiShown(withPii);
      setNotes(detail.internal_notes ?? '');
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    setError('');
    try {
      await adminFetch(`/api/admin/leads/${id}`, { method: 'PATCH', body });
      await load();
      if (selected?.id === id) await open(id, piiShown);
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <div>
      <div className="toolbar">
        <label className="visually-hidden" htmlFor="lead-status">
          Filter by status
        </label>
        <select
          id="lead-status"
          value={status}
          onChange={(event) => {
            setOffset(0);
            setStatus(event.target.value);
          }}
        >
          <option value="">All statuses</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {value.replace('_', ' ')}
            </option>
          ))}
        </select>
        {canExport && (
          // A plain link, not adminFetch: the response is a file download, and letting
          // the browser handle Content-Disposition beats building a Blob by hand. The
          // endpoint is a GET, so no CSRF token is required — and it is rate-limited,
          // live-rechecked and doubly audited on the server regardless.
          <a className="btn" href="/api/admin/leads/export" download>
            Export CSV
          </a>
        )}
      </div>

      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}

      <div className="card table-wrap">
        <table className="data">
          <caption className="visually-hidden">Leads</caption>
          <thead>
            <tr>
              <th scope="col">Received</th>
              <th scope="col">Name</th>
              <th scope="col">Interest</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{new Date(row.created_at).toLocaleDateString()}</td>
                <td>{row.name}</td>
                <td>{row.service_of_interest ?? '—'}</td>
                <td>
                  <label className="visually-hidden" htmlFor={`s-${row.id}`}>
                    Status for {row.name}
                  </label>
                  <select
                    id={`s-${row.id}`}
                    value={row.status}
                    onChange={(event) => void patch(row.id, { status: event.target.value })}
                  >
                    {STATUSES.map((value) => (
                      <option key={value} value={value}>
                        {value.replace('_', ' ')}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <button type="button" onClick={() => void open(row.id, false)}>
                    View
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5}>No leads yet.</td>
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

      {selected && (
        <div className="card card-detail">
          <h2 className="card-title">{selected.name}</h2>
          <p className="admin-sub">
            {new Date(selected.created_at).toLocaleString()} · {selected.locale.toUpperCase()}
          </p>
          <p className="prewrap">{selected.message}</p>

          {canSeePii && !piiShown && (
            <button type="button" onClick={() => void open(selected.id, true)}>
              Reveal contact details (this access is logged)
            </button>
          )}

          {piiShown && (
            <dl className="pii">
              <dt>Email</dt>
              <dd>{selected.email || '—'}</dd>
              <dt>Phone</dt>
              <dd>{selected.phone || '—'}</dd>
              <dt>Budget</dt>
              <dd>{selected.budget || '—'}</dd>
              <dt>Timeline</dt>
              <dd>{selected.timeline_band || '—'}</dd>
            </dl>
          )}

          {canSeePii && (
            <label className="field">
              <span>Internal notes</span>
              <textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
              <button
                type="button"
                onClick={() => void patch(selected.id, { internalNotes: notes })}
                className="spaced-top"
              >
                Save notes
              </button>
            </label>
          )}

          <p>
            <button type="button" onClick={() => setSelected(null)}>
              Close
            </button>
          </p>
        </div>
      )}
    </div>
  );
}
