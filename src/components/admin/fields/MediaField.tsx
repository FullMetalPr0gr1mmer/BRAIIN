import { useEffect, useRef, useState } from 'react';
import Icon from '@/components/admin/kit/Icon';
import { adminFetch, describeError } from '@/lib/admin/client';
import FieldShell from './FieldShell';
import type { FieldComponentProps } from './types';
import { labelOf } from './useOptions';

// One media asset, chosen in a native <dialog> (showModal gives the focus trap, Escape
// and the inert background for free — the same primitive as the shell's confirm()).
// The field stores the asset's id; the page resolves it to an image server-side.
//
// Thumbnails show when the media API returns a `thumb_url` (resolved per provider in
// UI v2 PR4a); until then an asset is identified by its alt text and path.
//
// v2 (Admin v2 F5a, ui.md §2.6, the prototype's .imgf): the choice is a tile, its thumbnail
// beside its name, Choose (or Change) and Remove, and a badge when its alt text is missing
// ("No alt text", "No Arabic alt"): the picture is chosen here, its words are written in
// the media library. The picker keeps its grid; uploading from it is U4's.

type MediaRow = Record<string, unknown>;

/** What the chosen asset's alt text lacks, in words, or null when both languages have it. */
export function altGap(row: MediaRow | null): string | null {
  if (!row || !('alt' in row)) return null;
  const alt = (row['alt'] && typeof row['alt'] === 'object' ? row['alt'] : {}) as MediaRow;
  const has = (lang: string) =>
    typeof alt[lang] === 'string' && (alt[lang] as string).trim() !== '';
  if (!has('en') && !has('ar')) return 'No alt text';
  if (!has('ar')) return 'No Arabic alt';
  if (!has('en')) return 'No English alt';
  return null;
}

const LIMIT = 100;

function caption(row: MediaRow): string {
  const alt = labelOf(row, 'alt');
  const path = typeof row['storage_path'] === 'string' ? row['storage_path'] : '';
  return alt && alt !== row['id'] ? alt : path || String(row['id'] ?? '');
}

export default function MediaField({
  field,
  value,
  onChange,
  idPrefix,
  errors,
}: FieldComponentProps) {
  const id = `${idPrefix}-${field.name}`;
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

  const gap = altGap(current);
  return (
    // A fieldset, so the Choose/Change/Remove buttons are announced with the field's name
    // ("Poster, group") — several media fields on one form would otherwise read alike.
    <FieldShell
      as="fieldset"
      id={id}
      label={field.label}
      required={field.required}
      hint={field.help}
      error={errors?.[id]}
    >
      <div className="imgf">
        <div className="imgf__pv">
          {current && typeof current['thumb_url'] === 'string' ? (
            <img src={current['thumb_url']} alt="" width="96" height="64" />
          ) : (
            <Icon name="image" size={20} />
          )}
        </div>
        <div className="imgf__body">
          <span className="item-label">{current ? caption(current) : 'No image chosen'}</span>
          {gap && (
            <span className="badge" data-tone="warn">
              {gap}
            </span>
          )}
          <span className="imgf__acts">
            <button type="button" className="btn" onClick={() => void open()}>
              <Icon name="image" size={14} />
              {selectedId ? 'Change…' : 'Choose…'}
            </button>
            {selectedId && (
              <button
                type="button"
                className="btn"
                data-variant="ghost"
                onClick={() => onChange(field.name, '')}
              >
                Remove
              </button>
            )}
          </span>
        </div>
      </div>

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
    </FieldShell>
  );
}
