import { useCallback, useEffect, useId, useRef, useState, type DragEvent } from 'react';
import EmptyState from '@/components/admin/kit/EmptyState';
import Note from '@/components/admin/kit/Note';
import Pager from '@/components/admin/kit/Pager';
import Segmented from '@/components/admin/kit/Segmented';
import MediaGrid from '@/components/admin/fields/media/MediaGrid';
import UploadDialog from '@/components/admin/fields/media/UploadDialog';
import type { MediaRow } from '@/components/admin/fields/media/format';
import { adminFetch, describeError } from '@/lib/admin/client';
import { pageInfo, rangeText } from '@/lib/admin/pager';
import {
  libraryQuery,
  viewHref,
  type LibraryTab,
  type LibraryView,
  type MediaPermissions,
} from './libraryState';
import MediaDrawer from './MediaDrawer';
import StorageMeter from './StorageMeter';
import VideosTab from './VideosTab';

// The media library (/admin/media, Admin v2 U4, ui.md "Media library (AV-11/12)", the
// prototype's route('/media')): one island over GET /api/admin/media/library.
//
//   the toolbar   a search (debounced, a newer request aborting the older), Images |
//                 Videos, "Needs alt text", and "Storage used" with its bar;
//   the dropzone  for the roles that may upload, where the Worker can take a file: drop
//                 pictures, or "Choose images" (a real button: dragging is never the only
//                 way, WCAG 2.5.7). Without the Images binding or Supabase: "Uploads are not
//                 set up yet." The page head's Upload does the same;
//   the grid      48 a page, server-paged, the kit Pager; a press opens the drawer, and the
//                 address follows it (/admin/media/<id>), so a reload or a link reopens it;
//   Videos        the site's own files, read-only (EXC-009).
//
// The first page is server-rendered (the page reads it through the same loader), so the
// screen paints with its pictures. Every button here is for the role's convenience only:
// each route checks the capability again.

export interface MediaStatsView {
  assets: number;
  bytes: number;
  quotaBytes: number;
  uploadsReady: boolean;
  canUpload: boolean;
}

export interface MediaLibraryProps {
  /** What the role may do, decided on the server (the buttons only; each route checks). */
  permissions: MediaPermissions;
  view: LibraryView;
  initial: { total: number; rows: MediaRow[] } | null;
  initialError?: string | null | undefined;
  stats: MediaStatsView | null;
  /** The picture whose drawer opens with the page (/admin/media/<id>). */
  openRow?: MediaRow | null | undefined;
  /** `?upload=1`: focus "Choose images" (a browser opens a file chooser only on a press). */
  startUpload?: boolean | undefined;
}

const LIMIT = 48;
const SEARCH_DELAY_MS = 250;
const ACCEPT = 'image/jpeg,image/png,image/webp';

const TABS = [
  { value: 'images', label: 'Images' },
  { value: 'videos', label: 'Videos' },
] as const;

export default function MediaLibrary({
  permissions,
  view: first,
  initial,
  initialError = null,
  stats: firstStats,
  openRow = null,
  startUpload = false,
}: MediaLibraryProps) {
  const [view, setView] = useState<LibraryView>(first);
  const [text, setText] = useState(first.q);
  const [page, setPage] = useState(initial);
  const [error, setError] = useState(initialError ?? '');
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState(firstStats);
  const [drawer, setDrawer] = useState<{ row: MediaRow; open: boolean } | null>(
    openRow ? { row: openRow, open: true } : null,
  );
  const [focusId, setFocusId] = useState<string | null>(null);
  const [files, setFiles] = useState<readonly File[]>([]);
  const [drag, setDrag] = useState(false);
  const [reload, setReload] = useState(0);
  const stale = useRef(false);
  const skipFirst = useRef(initial !== null);
  const fileInput = useRef<HTMLInputElement>(null);
  const chooseButton = useRef<HTMLButtonElement>(null);
  const searchId = useId();

  const canUpload = stats?.canUpload === true;
  const notSetUp = permissions.write && stats !== null && !stats.uploadsReady;

  // The address follows the view (never ?upload=1: it is read once).
  useEffect(() => {
    window.history.replaceState(window.history.state, '', viewHref(view));
  }, [view]);

  // The search box settles for a moment before it searches.
  useEffect(() => {
    if (text === view.q) return;
    const timer = window.setTimeout(
      () => setView((v) => ({ ...v, q: text.slice(0, 64), offset: 0 })),
      SEARCH_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [text, view.q]);

  // The page, whenever what it shows changes; a newer request aborts the older.
  useEffect(() => {
    if (view.tab !== 'images') return;
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    adminFetch<{ total: number; rows: MediaRow[] }>(
      `/api/admin/media/library?${libraryQuery(view)}`,
      { signal: controller.signal },
    )
      .then((next) => {
        // A page emptied past the end (the last picture on it deleted) steps back.
        if (next.rows.length === 0 && next.total > 0 && view.offset > 0) {
          setView((v) => ({ ...v, offset: pageInfo(next.total, next.total - 1, LIMIT).offset }));
          return;
        }
        setPage(next);
        setError('');
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(describeError(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [view.tab, view.q, view.needsAlt, view.offset, reload]);

  const refreshStats = useCallback(() => {
    adminFetch<MediaStatsView>('/api/admin/media/stats')
      .then(setStats)
      .catch(() => undefined);
  }, []);

  // The page head's Upload (a link to ?upload=1 without JavaScript): with it, a press opens
  // the file chooser straight away.
  useEffect(() => {
    if (!canUpload) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest('[data-media-upload]')) return;
      event.preventDefault();
      if (view.tab !== 'images') setView((v) => ({ ...v, tab: 'images' }));
      fileInput.current?.click();
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [canUpload, view.tab]);

  // ?upload=1: the way to the file chooser has focus.
  useEffect(() => {
    if (startUpload) chooseButton.current?.focus();
  }, []);

  // A file dropped beside the dropzone must not open in the tab instead.
  useEffect(() => {
    if (!canUpload) return;
    const hold = (event: globalThis.DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    window.addEventListener('dragover', hold);
    window.addEventListener('drop', hold);
    return () => {
      window.removeEventListener('dragover', hold);
      window.removeEventListener('drop', hold);
    };
  }, [canUpload]);

  function choose(list: FileList | null | undefined) {
    const chosen = list ? [...list] : [];
    if (chosen.length > 0) setFiles(chosen);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDrag(false);
    choose(event.dataTransfer.files);
  }

  function openPicture(row: MediaRow) {
    setDrawer({ row, open: true });
    setView((v) => ({ ...v, openId: String(row['id']) }));
  }

  function closeDrawer() {
    const id = drawer ? String(drawer.row['id']) : null;
    setDrawer(null);
    setView((v) => ({ ...v, openId: null }));
    setFocusId(id);
    if (stale.current) {
      stale.current = false;
      setReload((n) => n + 1);
    }
  }

  const info = page ? pageInfo(page.total, view.offset, LIMIT) : null;
  const q = view.q.trim();
  const status =
    view.tab === 'videos'
      ? null
      : loading && !page
        ? 'Loading…'
        : info && info.total > 0
          ? `Showing ${rangeText(info)}`
          : 'No pictures to show';

  return (
    <div className="media-lib">
      <div className="toolbar media-lib__bar">
        <div className="media-lib__search">
          <label htmlFor={searchId} className="visually-hidden">
            Search media
          </label>
          <input
            id={searchId}
            type="search"
            placeholder="Search by name, alt text or tag"
            maxLength={64}
            value={text}
            disabled={view.tab !== 'images'}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <Segmented
          label="Show"
          options={TABS}
          value={view.tab}
          onChange={(tab: LibraryTab) => setView((v) => ({ ...v, tab, offset: 0 }))}
        />
        {view.tab === 'images' && (
          <button
            type="button"
            className="chip"
            aria-pressed={view.needsAlt}
            onClick={() => setView((v) => ({ ...v, needsAlt: !v.needsAlt, offset: 0 }))}
          >
            Needs alt text
          </button>
        )}
        {stats && <StorageMeter bytes={stats.bytes} quotaBytes={stats.quotaBytes} />}
      </div>
      <p className="admin-sub media-lib__status" aria-live="polite">
        {status}
      </p>

      {view.tab === 'videos' ? (
        <VideosTab />
      ) : (
        <>
          {canUpload && (
            <div
              className="dropzone"
              data-drag={drag ? 'over' : undefined}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes('Files')) return;
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={onDrop}
            >
              <p>Drop images here or choose Upload. JPEG, PNG or WebP, up to 20 MB each.</p>
              <button
                ref={chooseButton}
                type="button"
                className="btn"
                onClick={() => fileInput.current?.click()}
              >
                Choose images
              </button>
            </div>
          )}
          {notSetUp && <Note>Uploads are not set up yet.</Note>}

          {error && (
            <p className="msg" data-kind="error" role="alert">
              {error}
            </p>
          )}

          {page && page.rows.length === 0 && !error ? (
            q ? (
              <EmptyState icon="search" title={`No pictures match "${q}".`}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setText('');
                    setView((v) => ({ ...v, q: '', offset: 0 }));
                  }}
                >
                  Clear search
                </button>
              </EmptyState>
            ) : view.needsAlt ? (
              <EmptyState icon="check" title="Every picture has alt text in both languages." />
            ) : (
              <EmptyState icon="image" title="No pictures yet.">
                {canUpload && (
                  <button type="button" className="btn" onClick={() => fileInput.current?.click()}>
                    Upload
                  </button>
                )}
              </EmptyState>
            )
          ) : null}

          {page && page.rows.length > 0 && (
            <MediaGrid
              rows={page.rows}
              mode="open"
              label="Pictures"
              selectedId={drawer?.open ? String(drawer.row['id']) : null}
              onPress={openPicture}
              focusId={focusId}
            />
          )}
          {info && (
            <Pager
              info={info}
              onPage={(offset) => setView((v) => ({ ...v, offset }))}
              label="Picture pages"
            />
          )}
        </>
      )}

      {canUpload && (
        <input
          ref={fileInput}
          type="file"
          className="visually-hidden"
          tabIndex={-1}
          aria-hidden="true"
          multiple
          accept={ACCEPT}
          onChange={(e) => {
            choose(e.target.files);
            e.target.value = '';
          }}
        />
      )}

      {drawer && (
        <MediaDrawer
          row={drawer.row}
          open={drawer.open}
          permissions={permissions}
          canReplace={canUpload}
          onClose={closeDrawer}
          onChanged={() => {
            stale.current = true;
          }}
          onDeleted={() => {
            stale.current = true;
            setDrawer((d) => (d ? { ...d, open: false } : d));
            refreshStats();
          }}
        />
      )}

      <UploadDialog
        files={files}
        onClose={() => setFiles([])}
        onUploaded={() => {
          setView((v) => ({ ...v, offset: 0 }));
          setReload((n) => n + 1);
          refreshStats();
        }}
      />
    </div>
  );
}
