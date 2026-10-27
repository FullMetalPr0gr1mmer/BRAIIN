import { useCallback, useEffect, useState } from 'react';
import Drawer from '@/components/admin/kit/Drawer';
import Note from '@/components/admin/kit/Note';
import { Badge } from '@/components/admin/kit/StatusBadge';
import { useClock } from '@/components/admin/kit/clock';
import { AdminApiError, adminFetch } from '@/lib/admin/client';
import { confirmDialog } from '@/lib/admin/confirm';
import type { HistoryTarget } from '@/lib/admin/historyTarget';
import { announcePending } from '@/lib/admin/releaseEvents';
import { toast } from '@/lib/admin/toast';
import { HISTORY_COPY as COPY, historyRowTitle, type HistoryAnswer } from './model';

// The history drawer (Admin v2 R13; releases.md §7 "History drawer"; R10's history and restore).
// Every editor of a release-managed record opens it from its History button; this module is the
// `admin-history` chunk, which an editor loads through import() the first time someone opens it.
//
// It lists GET /api/admin/history (the person must read the record's area, else 403, said here):
// the pending change on top (Preview, Discard), then every version of the record that went live,
// newest first, numbered (R10's `seq`), the live one marked, each with the site version that
// made it. An older version made by a release previews as that version of the site (`?v=N`, R10
// departure 11); one saved while releases were off has no version to preview. Restore (R10's
// one-snapshot restore) stages that version as a pending change, only when the server says it
// may (`restorable`: releases on and a role that publishes the record's type). Releases off: the
// list is what exists (every save made a version), and the drawer says restoring needs releases.
// Every refusal is said in the drawer, never as a toast.

export interface HistoryDrawerProps {
  open: boolean;
  onClose: () => void;
  target: HistoryTarget;
  /** The record in words, for the title ("History: Logo design"). */
  label: string;
  /** The record's public path, for Preview, or null when it has no page of its own. */
  publicPath: string | null;
  /** A restore or a discard landed: the editor reads the record again. */
  onChanged: () => void;
}

function refusal(err: unknown, fallback: string): string {
  if (err instanceof AdminApiError) {
    if (err.info.detail) return err.info.detail;
    if (err.info.status === 403) return COPY.forbidden;
  }
  return fallback;
}

export default function HistoryDrawer({
  open,
  onClose,
  target,
  label,
  publicPath,
  onChanged,
}: HistoryDrawerProps) {
  const clock = useClock();
  const [answer, setAnswer] = useState<HistoryAnswer | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const query = `/api/admin/history?entityType=${encodeURIComponent(target.entityType)}&entityId=${encodeURIComponent(target.entityId)}`;
  const load = useCallback(
    async (before?: number) => {
      try {
        const page = await adminFetch<HistoryAnswer>(before ? `${query}&before=${before}` : query);
        setAnswer((had) =>
          before && had ? { ...page, versions: [...had.versions, ...page.versions] } : page,
        );
        setError('');
      } catch (err) {
        setError(refusal(err, COPY.unreadable));
      }
    },
    [query],
  );

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function act(work: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (err) {
      setError(refusal(err, fallback));
    } finally {
      setBusy(false);
    }
  }

  const restore = (seq: number) =>
    act(async () => {
      if (
        !(await confirmDialog({
          message: COPY.restoreConfirm(seq),
          confirmLabel: 'Restore',
          danger: false,
        }))
      )
        return;
      await adminFetch('/api/admin/history/restore', {
        method: 'POST',
        body: { entityType: target.entityType, entityId: target.entityId, seq },
      });
      toast(COPY.restored(seq), 'ok');
      announcePending();
      onChanged();
      await load();
    }, COPY.restoreFailed);

  const discard = (draftId: string, version: number) =>
    act(async () => {
      if (!(await confirmDialog({ message: COPY.discardConfirm(label), confirmLabel: 'Discard' })))
        return;
      await adminFetch(`/api/admin/drafts/${encodeURIComponent(draftId)}?version=${version}`, {
        method: 'DELETE',
      });
      toast(COPY.discarded, 'ok');
      announcePending();
      onChanged();
      await load();
    }, COPY.discardFailed);

  const pending = answer?.enabled ? answer.pending : null;
  const last = answer?.versions[answer.versions.length - 1];
  return (
    <Drawer open={open} onClose={onClose} title={`History: ${label}`}>
      <p className="admin-sub">{COPY.sub}</p>
      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}
      {target.entityType === 'team_member' && (
        <Note>
          <p>{COPY.teamNoHistory}</p>
        </Note>
      )}
      {answer && !answer.enabled && (
        <Note>
          <p>{COPY.off}</p>
        </Note>
      )}
      {!answer && !error && <p className="admin-sub">Loading…</p>}
      {pending && (
        <Note tone="warn" className="hist__pending">
          <p>
            <strong>{COPY.pendingTitle}</strong>
            {[pending.by?.name, clock.relTime(pending.at)]
              .filter(Boolean)
              .map((part) => ` · ${part}`)}
          </p>
          <p>{pending.scheduled ? COPY.pendingScheduled : COPY.pendingLine}</p>
          <div className="hist__acts">
            {publicPath && (
              <a
                className="btn"
                data-size="sm"
                href={`/admin/preview${publicPath}`}
                target="_blank"
                rel="noopener"
              >
                Preview
                <span className="visually-hidden">
                  {' '}
                  the unpublished changes (opens in a new tab)
                </span>
              </a>
            )}
            {!pending.scheduled && (
              <button
                type="button"
                className="btn"
                data-size="sm"
                disabled={busy}
                onClick={() => void discard(pending.draftId, pending.draftVersion)}
              >
                Discard<span className="visually-hidden"> the unpublished changes</span>
              </button>
            )}
          </div>
        </Note>
      )}
      {answer && answer.versions.length === 0 && target.entityType !== 'team_member' && (
        <p className="admin-sub">{COPY.empty}</p>
      )}
      {answer && answer.versions.length > 0 && (
        <ol className="tl" aria-label={`Versions of ${label}`}>
          {answer.versions.map((v) => {
            const number = v.release?.number ?? null;
            return (
              <li key={v.seq} className="tl__i">
                <p className="tl__t">
                  {historyRowTitle(v)} {v.live && <Badge tone="ok">Live now</Badge>}
                </p>
                <p className="tl__s">
                  {[v.by?.name ? `by ${v.by.name}` : null, clock.formatDateTime(v.at)]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                {!v.live && (
                  <div className="hist__acts">
                    {number !== null && publicPath && (
                      <a
                        className="btn"
                        data-size="sm"
                        href={`/admin/preview${publicPath}?v=${number}`}
                        target="_blank"
                        rel="noopener"
                      >
                        Preview
                        <span className="visually-hidden">
                          {' '}
                          version {v.seq} (opens in a new tab)
                        </span>
                      </a>
                    )}
                    {answer.restorable && !pending && (
                      <button
                        type="button"
                        className="btn"
                        data-size="sm"
                        disabled={busy}
                        onClick={() => void restore(v.seq)}
                      >
                        Restore<span className="visually-hidden"> version {v.seq}</span>
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {answer?.more && last && (
        <button type="button" className="btn" onClick={() => void load(last.seq)}>
          Older versions
        </button>
      )}
    </Drawer>
  );
}
