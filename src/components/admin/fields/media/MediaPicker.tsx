import { useCallback, useEffect, useId, useRef, useState } from 'react';
import EmptyState from '@/components/admin/kit/EmptyState';
import Modal from '@/components/admin/kit/Modal';
import Pager from '@/components/admin/kit/Pager';
import { adminFetch, describeError } from '@/lib/admin/client';
import { pageInfo, rangeText } from '@/lib/admin/pager';
import BodyPortal from './BodyPortal';
import type { MediaRow } from './format';
import MediaGrid from './MediaGrid';
import UploadDialog from './UploadDialog';

// The picker every picture field opens (Admin v2 U4, ui.md field kit "media v2", the
// prototype's mediaPicker): the library's grid in a dialog. A search over names, alt text in
// both languages and tags (the library's own route, GET /api/admin/media/library), pages of
// 48, images only (D2: no picture field stores a video). A press or Space selects a picture,
// Enter or a double click chooses it, "Use image" chooses the selected one. Upload in place:
// one file, described in both languages, sent, and chosen.
//
// Frozen at U4's merge (U5 and U6 build on it): the props below. U6 opens it once per gallery
// item; `onPick` stays single.
//
// The dialog is rendered at the end of <body> (BodyPortal), so Enter in its search box can
// never submit the edit form around the field, and the upload dialog stacks above it.

export interface MediaPickerProps {
  open: boolean;
  onClose: () => void;
  /** Called with the chosen asset's row (id, alt, thumb_url, width, height, display_name). */
  onPick: (row: MediaRow) => void;
  /** The dialog's name, e.g. "Poster: choose". */
  title: string;
  /** The tile shown as selected when it opens. */
  selectedId?: string | null | undefined;
  /** Upload in place (default true; shown only where the role and the Worker allow it). */
  upload?: boolean | undefined;
}

interface Page {
  total: number;
  rows: MediaRow[];
}

const LIMIT = 48;
const SEARCH_DELAY_MS = 250;

export default function MediaPicker({
  open,
  onClose,
  onPick,
  title,
  selectedId = null,
  upload = true,
}: MediaPickerProps) {
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(selectedId);
  const [canUpload, setCanUpload] = useState(false);
  const [files, setFiles] = useState<readonly File[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const statusId = useId();
  const searchId = useId();

  // Each opening starts from the stored choice and the first page.
  useEffect(() => {
    if (!open) return;
    setSelected(selectedId);
    setError('');
  }, [open, selectedId]);

  // Whether Upload may be offered: the role holds media.write at full and the Worker can
  // take a file (GET /api/admin/media/stats). Asked once per opening; the route checks again.
  useEffect(() => {
    if (!open || !upload) return;
    const controller = new AbortController();
    adminFetch<{ canUpload?: boolean }>('/api/admin/media/stats', { signal: controller.signal })
      .then((stats) => setCanUpload(stats.canUpload === true))
      .catch(() => setCanUpload(false));
    return () => controller.abort();
  }, [open, upload]);

  // The page: debounced while typing, and a newer request aborts the older one.
  const load = useCallback((q: string, from: number, signal: AbortSignal) => {
    const params = new URLSearchParams({ limit: String(LIMIT), offset: String(from) });
    if (q.trim()) params.set('q', q.trim().slice(0, 64));
    return adminFetch<Page>(`/api/admin/media/library?${params}`, { signal })
      .then((next) => {
        // A page emptied past the end steps back to the last one that exists.
        if (next.rows.length === 0 && next.total > 0 && from > 0) {
          setOffset(pageInfo(next.total, next.total - 1, LIMIT).offset);
          return;
        }
        setPage(next);
        setError('');
      })
      .catch((err: unknown) => {
        if (signal.aborted) return;
        setError(describeError(err));
      });
  }, []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => void load(query, offset, controller.signal),
      page === null ? 0 : SEARCH_DELAY_MS,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // `page` only decides the first load's delay.
  }, [open, query, offset, load]);

  const choose = (row: MediaRow) => {
    onPick(row);
    onClose();
  };
  const chosenRow = page?.rows.find((r) => String(r['id']) === selected) ?? null;
  const info = page ? pageInfo(page.total, offset, LIMIT) : null;
  const showUpload = upload && canUpload;

  return (
    <BodyPortal>
      <Modal
        open={open}
        onClose={onClose}
        title={title}
        sub="Double click or press Enter to choose, or select a picture and choose Use image."
        size="lg"
        footer={
          <>
            {showUpload && (
              <button
                type="button"
                className="btn media-pick__upload"
                onClick={() => fileInput.current?.click()}
              >
                Upload
              </button>
            )}
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              data-variant="primary"
              disabled={!chosenRow}
              onClick={() => chosenRow && choose(chosenRow)}
            >
              Use image
            </button>
          </>
        }
      >
        <div className="toolbar media-pick__bar">
          <label htmlFor={searchId} className="visually-hidden">
            Search media
          </label>
          <input
            id={searchId}
            type="search"
            placeholder="Search by name, alt text or tag"
            maxLength={64}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOffset(0);
            }}
            onKeyDown={(e) => {
              // A belt: the dialog is outside any form (BodyPortal), but Enter here must never
              // do anything but search.
              if (e.key === 'Enter') e.preventDefault();
            }}
          />
          <p id={statusId} className="admin-sub" aria-live="polite">
            {info ? `Showing ${rangeText(info)}` : 'Loading…'}
          </p>
        </div>
        {error && (
          <p className="msg" data-kind="error" role="alert">
            {error}
          </p>
        )}
        {page && page.rows.length === 0 && !error ? (
          <EmptyState
            icon="image"
            title={query.trim() ? `No pictures match "${query.trim()}".` : 'No pictures yet.'}
          />
        ) : null}
        {page && page.rows.length > 0 && (
          <MediaGrid
            rows={page.rows}
            mode="pick"
            label="Pictures"
            selectedId={selected}
            onPress={(row) => setSelected(String(row['id']))}
            onChoose={choose}
          />
        )}
        {info && <Pager info={info} onPage={setOffset} label="Picture pages" />}
        {showUpload && (
          <input
            ref={fileInput}
            type="file"
            className="visually-hidden"
            tabIndex={-1}
            aria-hidden="true"
            accept="image/jpeg,image/png,image/webp"
            onChange={(e) => {
              const chosen = e.target.files ? [...e.target.files].slice(0, 1) : [];
              e.target.value = '';
              if (chosen.length > 0) setFiles(chosen);
            }}
          />
        )}
      </Modal>
      <UploadDialog
        files={files}
        single
        onClose={() => setFiles([])}
        onUploaded={(rows) => {
          const row = rows[0];
          if (row) choose(row);
        }}
      />
    </BodyPortal>
  );
}
