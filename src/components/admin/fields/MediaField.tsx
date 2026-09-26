import { useEffect, useRef, useState } from 'react';
import { adminFetch, describeError } from '@/lib/admin/client';
import type { FieldDef } from '@/lib/admin/uiSchema';
import { labelOf } from './useOptions';

// One media asset, chosen in a native <dialog> (showModal gives the focus trap, Escape
// and the inert background for free — the same primitive as the shell's confirm()).
// The field stores the asset's id; the page resolves it to an image server-side.
//
// Thumbnails show when the media API returns a `thumb_url` (resolved per provider in
// UI v2 PR4a); until then an asset is identified by its alt text and path.

type MediaRow = Record<string, unknown>;

interface Props {
  field: FieldDef;
  value: unknown;
  onChange: (name: string, value: unknown) => void;
}

const LIMIT = 100;

function caption(row: MediaRow): string {
  const alt = labelOf(row, 'alt');
  const path = typeof row['storage_path'] === 'string' ? row['storage_path'] : '';
  return alt && alt !== row['id'] ? alt : path || String(row['id'] ?? '');
}

export default function MediaField({ field, value, onChange }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [rows, setRows] = useState<MediaRow[] | null>(null);
  const [current, setCurrent] = useState<MediaRow | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const selectedId = typeof value === 'string' ? value : '';

  // Describe the stored selection (it may not be on the first page of the picker).
  useEffect(() => {
    if (!selectedId) {
      setCurrent(null);
      return;
    }
    const controller = new AbortController();
    adminFetch<MediaRow>(`/api/admin/media/${selectedId}`, { signal: controller.signal })
      .then(setCurrent)
      .catch(() => setCurrent({ id: selectedId }));
    return () => controller.abort();
  }, [selectedId]);

  async function open() {
    setError('');
    dialog.current?.showModal();
    if (rows !== null) return;
    try {
      const params = new URLSearchParams({ limit: String(LIMIT), kind: 'image' });
      const { rows: list } = await adminFetch<{ rows: MediaRow[] }>(`/api/admin/media?${params}`);
      setRows(list);
    } catch (err) {
      setError(describeError(err));
    }
  }

  function choose(id: string) {
    onChange(field.name, id);
    dialog.current?.close();
  }

  const needle = query.trim().toLowerCase();
  const visible = (rows ?? []).filter((r) => !needle || caption(r).toLowerCase().includes(needle));

  return (
    // A fieldset, so the Choose/Change/Remove buttons are announced with the field's name
    // ("Poster, group") — several media fields on one form would otherwise read alike.
    <fieldset className="field-group">
      <legend className="field-legend">
        {field.label}
        {field.required ? ' *' : ''}
      </legend>
      <div className="media-current">
        {current && typeof current['thumb_url'] === 'string' ? (
          <img className="media-thumb" src={current['thumb_url']} alt="" width="96" height="64" />
        ) : null}
        <span className="item-label">{current ? caption(current) : 'No image chosen'}</span>
        <button type="button" className="btn" onClick={() => void open()}>
          {selectedId ? 'Change…' : 'Choose…'}
        </button>
        {selectedId && (
          <button type="button" className="btn" onClick={() => onChange(field.name, '')}>
            Remove
          </button>
        )}
      </div>
      {field.help && <p className="admin-sub">{field.help}</p>}

      <dialog
        ref={dialog}
        className="admin-dialog media-dialog"
        aria-label={`${field.label}: choose`}
      >
        <div className="toolbar">
          <input
            type="search"
            placeholder="Filter by alt text or path"
            aria-label="Filter media"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // The dialog sits INSIDE the edit <form> in the DOM, so Enter here would
              // implicitly submit it (inert does not count as disabled).
              if (e.key === 'Enter') e.preventDefault();
            }}
          />
          <button type="button" className="btn" onClick={() => dialog.current?.close()}>
            Close
          </button>
        </div>
        {error && (
          <p className="msg" data-kind="error" role="alert">
            {error}
          </p>
        )}
        {rows === null && !error ? <p>Loading…</p> : null}
        {rows !== null && visible.length === 0 ? (
          <p className="admin-sub">No images match.</p>
        ) : null}
        <ul className="media-grid">
          {visible.map((row) => {
            const rowId = String(row['id']);
            return (
              <li key={rowId}>
                <button
                  type="button"
                  className="media-pick"
                  aria-pressed={rowId === selectedId}
                  onClick={() => choose(rowId)}
                >
                  {typeof row['thumb_url'] === 'string' ? (
                    <img
                      className="media-thumb"
                      src={row['thumb_url']}
                      alt=""
                      width="160"
                      height="107"
                    />
                  ) : null}
                  <span>{caption(row)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </dialog>
    </fieldset>
  );
}
