import { useCallback, useEffect, useState } from 'react';
import Drawer from '@/components/admin/kit/Drawer';
import Note from '@/components/admin/kit/Note';
import { Badge } from '@/components/admin/kit/StatusBadge';
import { useClock } from '@/components/admin/kit/clock';
import { adminFetch, describeError } from '@/lib/admin/client';
import { toast } from '@/lib/admin/toast';
import { announcePending } from '@/lib/admin/releaseEvents';
import { historyRows, pageVersionRows, type ItemHistory, type PageHistory } from './history';

// The History drawer (Admin v2 E1, ui.md "History drawer"; the prototype's historyDrawer):
// what R10's `GET /api/admin/history` answers, under the person's own RLS.
//   - The open item's saves (the section, or the page details), newest first: its number,
//     who saved it and when, the one the site shows now, and the site version that made it
//     once releases are on. While releases are off that is every save a person made.
//   - Releases on: Restore a save as an unpublished change (R10's per-item restore), and the
//     site versions that changed this page with Preview (R9's preview at that version) and
//     Restore this page as it was (R10's page-scoped restore, staged, published from the bar).
// A snapshot's content is never listed (R10); a restore stages a change, never a live write.

export interface HistoryTarget {
  entityType: 'page' | 'page_section';
  entityId: string;
  /** The item in words, for the drawer's heading. */
  name: string;
}

export interface HistoryDrawerProps {
  open: boolean;
  onClose: () => void;
  target: HistoryTarget;
  /** The page whose site versions are listed (releases on). */
  pageId: string;
  /** The page's public path, for a version's preview; null when no route renders it. */
  path: string | null;
  /** A restore was staged: the editor reads the item again. */
  onRestored: () => void;
}

export default function HistoryDrawer({
  open,
  onClose,
  target,
  pageId,
  path,
  onRestored,
}: HistoryDrawerProps) {
  const clock = useClock();
  const [item, setItem] = useState<ItemHistory | null>(null);
  const [page, setPage] = useState<PageHistory | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const query = new URLSearchParams({
        entityType: target.entityType,
        entityId: target.entityId,
      });
      const answer = await adminFetch<ItemHistory>(`/api/admin/history?${query.toString()}`);
      setItem(answer);
      if (answer.enabled) {
        const scope = new URLSearchParams({ entityType: 'page', entityId: pageId, scope: 'page' });
        setPage(await adminFetch<PageHistory>(`/api/admin/history?${scope.toString()}`));
      } else {
        setPage(null);
      }
    } catch (err) {
      setError(`The history could not be read. ${describeError(err)}`);
    }
  }, [target.entityType, target.entityId, pageId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function restoreSave(seq: number) {
    setWorking(true);
    setError('');
    try {
      await adminFetch('/api/admin/history/restore', {
        method: 'POST',
        body: { entityType: target.entityType, entityId: target.entityId, seq },
      });
      announcePending();
      toast('Restored as an unpublished change. Publish it to put it back on the site.', 'ok');
      onRestored();
      await load();
    } catch (err) {
      setError(`Not restored. ${describeError(err)}`);
    } finally {
      setWorking(false);
    }
  }

  async function restorePage(releaseId: string) {
    setWorking(true);
    setError('');
    try {
      await adminFetch(`/api/admin/releases/${releaseId}/restore`, {
        method: 'POST',
        body: { pageId },
      });
      announcePending();
      toast('This page as it was is now an unpublished change. Publish it to put it back.', 'ok');
      onRestored();
      await load();
    } catch (err) {
      setError(`Not restored. ${describeError(err)}`);
    } finally {
      setWorking(false);
    }
  }

  const saves = item ? historyRows(item, clock) : [];
  const versions = page ? pageVersionRows(page, clock) : [];

  return (
    <Drawer open={open} onClose={onClose} title={`History: ${target.name}`}>
      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}
      {item === null && !error && <p className="admin-sub">Loading…</p>}
      {item !== null && (
        <section className="pe__hist" aria-labelledby="pe-hist-saves">
          <h3 id="pe-hist-saves" className="pe__h3">
            Saves
          </h3>
          {item.pending && (
            <Note tone="info">
              {item.pending.scheduled
                ? 'A change to it is scheduled to go live.'
                : 'It has an unpublished change waiting to be published.'}
            </Note>
          )}
          {saves.length === 0 ? (
            <p className="admin-sub">No saves yet.</p>
          ) : (
            <ol className="tl">
              {saves.map((save) => (
                <li key={save.seq} className="tl__i">
                  <p className="tl__t">
                    {save.title} {save.live && <Badge tone="ok">Live now</Badge>}
                  </p>
                  <p className="tl__s" dir="auto">
                    {save.by}
                  </p>
                  <time className="tl__m" dateTime={save.iso} title={save.full}>
                    {save.when}
                  </time>
                  {item.restorable && !save.live && (
                    <button
                      type="button"
                      className="btn"
                      data-size="sm"
                      disabled={working}
                      onClick={() => void restoreSave(save.seq)}
                    >
                      Restore this save
                    </button>
                  )}
                </li>
              ))}
            </ol>
          )}
          {!item.enabled && (
            <p className="admin-sub">Each save went live on the site when it was made.</p>
          )}
        </section>
      )}
      {page !== null && (
        <section className="pe__hist" aria-labelledby="pe-hist-versions">
          <h3 id="pe-hist-versions" className="pe__h3">
            Site versions that changed this page
          </h3>
          {versions.length === 0 ? (
            <p className="admin-sub">No published version has changed this page yet.</p>
          ) : (
            <ol className="tl">
              {versions.map((version) => (
                <li key={version.id} className="tl__i">
                  <p className="tl__t">{version.title}</p>
                  {version.note && (
                    <p className="tl__s" dir="auto">
                      {version.note}
                    </p>
                  )}
                  <p className="tl__s" dir="auto">
                    {version.by}
                  </p>
                  {version.iso && (
                    <time className="tl__m" dateTime={version.iso} title={version.full}>
                      {version.when}
                    </time>
                  )}
                  <span className="pe__hist-acts">
                    {path && version.number !== null && (
                      <a
                        className="btn"
                        data-size="sm"
                        href={`/admin/preview${path}?v=${version.number}`}
                        target="_blank"
                        rel="noopener"
                      >
                        Preview
                      </a>
                    )}
                    {page.restorable && (
                      <button
                        type="button"
                        className="btn"
                        data-size="sm"
                        disabled={working}
                        onClick={() => void restorePage(version.id)}
                      >
                        Restore this page as it was
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </Drawer>
  );
}
