import { useCallback, useEffect, useState } from 'react';
import { adminFetch, describeError } from '@/lib/admin/client';
import {
  APPLICATION_STATUSES,
  AVAILABILITY,
  CRAFTS,
  EXPERIENCE_LEVELS,
  SPAM_RETENTION_DAYS,
  WORK_TYPES,
  optionLabel,
} from '@schemas/application';

// Job applications (Join) — Admin only. The leads panel's pattern, with one difference in
// what is personal data: here the contact details AND the CV are, and both are fetched one
// application at a time by a deliberate click the server audits (`?pii=1`, `[id]/cv`).
//
// Notes are not personal data in this table (it is Admin-only to begin with), so they come
// with the ordinary detail — the notes box always shows what is stored, and a save can
// never blank notes the panel had not loaded (the leads panel's bug, not repeated here).

interface ApplicationRow {
  id: string;
  created_at: string;
  locale: string;
  name: string;
  city: string;
  role: string;
  experience: string;
  work_type: string;
  availability: string;
  skills: string[];
  portfolio_url: string;
  linkedin_url: string | null;
  status: string;
  future_roles_consent: boolean;
  retention_delete_after: string;
  has_cv: boolean;
  cv_content_type: string | null;
  cv_bytes: number | null;
}

interface ApplicationDetail extends ApplicationRow {
  message: string;
  internal_notes: string | null;
  consent_at: string;
  consent_version: string;
  email?: string | null;
  phone?: string | null;
}

interface ListResponse {
  rows: ApplicationRow[];
  total: number;
}

export interface ApplicationsPanelProps {
  /** Mirrors `applications.pii` — UX only; the server decides. */
  canSeePii: boolean;
}

const PAGE_SIZE = 25;

/** `1.2 MB` / `850 KB`. */
export function formatBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return '';
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** A link the admin may open: https only (the schema and the 0029 CHECK already insist). */
export function safeLink(url: string | null | undefined): string | null {
  return typeof url === 'string' && /^https:\/\//i.test(url) ? url : null;
}

export default function ApplicationsPanel({ canSeePii }: ApplicationsPanelProps) {
  const [rows, setRows] = useState<ApplicationRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<ApplicationDetail | null>(null);
  const [piiShown, setPiiShown] = useState(false);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (status) params.set('status', status);
      const data = await adminFetch<ListResponse>(`/api/admin/applications?${params.toString()}`);
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
    setNotice('');
    try {
      const detail = await adminFetch<ApplicationDetail>(
        `/api/admin/applications/${id}${withPii ? '?pii=1' : ''}`,
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
      await adminFetch(`/api/admin/applications/${id}`, { method: 'PATCH', body });
      await load();
      if (selected?.id === id) await open(id, piiShown);
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function erase(id: string, name: string) {
    // eslint-disable-next-line no-alert -- a destructive, irreversible action deserves a plain confirm
    if (!window.confirm(`Erase ${name}'s application and CV? This cannot be undone.`)) return;
    setError('');
    try {
      await adminFetch(`/api/admin/applications/${id}`, { method: 'DELETE' });
      setSelected(null);
      setNotice('Application erased.');
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <div>
      <div className="toolbar">
        <label className="visually-hidden" htmlFor="application-status">
          Filter by status
        </label>
        <select
          id="application-status"
          value={status}
          onChange={(event) => {
            setOffset(0);
            setStatus(event.target.value);
          }}
        >
          <option value="">All statuses</option>
          {APPLICATION_STATUSES.map((value) => (
            <option key={value} value={value}>
              {value.replace('_', ' ')}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="msg" role="status">
          {notice}
        </p>
      )}

      <div className="card table-wrap">
        <table className="data">
          <caption className="visually-hidden">Job applications</caption>
          <thead>
            <tr>
              <th scope="col">Received</th>
              <th scope="col">Name</th>
              <th scope="col">Role</th>
              <th scope="col">Experience</th>
              <th scope="col">CV</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{new Date(row.created_at).toLocaleDateString()}</td>
                <td>{row.name}</td>
                <td>{row.role}</td>
                <td>{optionLabel(EXPERIENCE_LEVELS, row.experience)}</td>
                <td>{row.has_cv ? 'Yes' : '—'}</td>
                <td>
                  <label className="visually-hidden" htmlFor={`s-${row.id}`}>
                    Status for {row.name}
                  </label>
                  <select
                    id={`s-${row.id}`}
                    value={row.status}
                    onChange={(event) => void patch(row.id, { status: event.target.value })}
                  >
                    {APPLICATION_STATUSES.map((value) => (
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
                <td colSpan={7}>No applications yet.</td>
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
            {new Date(selected.created_at).toLocaleString()} · {selected.locale.toUpperCase()} ·{' '}
            {selected.city}
          </p>
          <dl className="pii">
            <dt>Role</dt>
            <dd>{selected.role}</dd>
            <dt>Experience</dt>
            <dd>{optionLabel(EXPERIENCE_LEVELS, selected.experience)}</dd>
            <dt>Works</dt>
            <dd>{optionLabel(WORK_TYPES, selected.work_type)}</dd>
            <dt>Can start</dt>
            <dd>{optionLabel(AVAILABILITY, selected.availability)}</dd>
            <dt>Crafts</dt>
            <dd>
              {selected.skills.length > 0
                ? selected.skills.map((s) => optionLabel(CRAFTS, s)).join(', ')
                : '—'}
            </dd>
            <dt>Portfolio</dt>
            <dd>
              {safeLink(selected.portfolio_url) ? (
                <a href={selected.portfolio_url} target="_blank" rel="noopener noreferrer">
                  {selected.portfolio_url}
                </a>
              ) : (
                '—'
              )}
            </dd>
            <dt>LinkedIn</dt>
            <dd>
              {safeLink(selected.linkedin_url) ? (
                <a href={selected.linkedin_url ?? ''} target="_blank" rel="noopener noreferrer">
                  {selected.linkedin_url}
                </a>
              ) : (
                '—'
              )}
            </dd>
            <dt>Consent</dt>
            <dd>
              {new Date(selected.consent_at).toLocaleDateString()} (notice{' '}
              {selected.consent_version})
              {selected.future_roles_consent ? ' · future roles too' : ''}
            </dd>
            <dt>Kept until</dt>
            <dd>
              {new Date(selected.retention_delete_after).toLocaleDateString()}
              {selected.status === 'spam'
                ? ''
                : ` · marking it spam deletes it within ${SPAM_RETENTION_DAYS} days`}
            </dd>
          </dl>
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
            </dl>
          )}

          {canSeePii && selected.has_cv && (
            <p>
              {/* A plain link: the server answers with an attachment, audited and rate-limited. */}
              <a className="btn" href={`/api/admin/applications/${selected.id}/cv`} download>
                Download CV ({formatBytes(selected.cv_bytes)}) — this access is logged
              </a>{' '}
              <span className="badge" data-status="scheduled">
                Not virus-scanned
              </span>
            </p>
          )}

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

          <p className="toolbar">
            <button type="button" onClick={() => setSelected(null)}>
              Close
            </button>
            <button
              type="button"
              data-variant="danger"
              onClick={() => void erase(selected.id, selected.name)}
            >
              Erase application
            </button>
          </p>
        </div>
      )}
    </div>
  );
}
