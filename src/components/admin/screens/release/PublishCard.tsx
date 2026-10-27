import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/admin/kit/StatusBadge';
import { useClock } from '@/components/admin/kit/clock';
import { openPublishDialog, PENDING_EVENT } from '@/lib/admin/releaseEvents';
import { toast } from '@/lib/admin/toast';
import type { PurgeRetryResult, ReleaseStatusAnswer } from '@schemas/release';
import { refusalOf } from './api';

// The dashboard's "Publish status" card (Admin v2 R13; releases.md §7): the live version and
// who published it when, the unpublished changes (mine to publish, waiting), the next scheduled
// release, the website cache, maintenance, and Publish now (R12's dialog) when anything is mine
// to publish. Its figures are GET /api/admin/releases/status, read when the card loads and
// again after a save, a publish or a return to the tab (as the savebar reads its summary), so
// the card and the bar never disagree. The AdminPublishCard island draws it only while releases
// are on; the kit gallery draws it over a made-up status (`load`), sending nothing.

export interface PublishCardProps {
  load: () => Promise<ReleaseStatusAnswer>;
  retry: (releaseId: string) => Promise<PurgeRetryResult>;
  /** The kit's gallery: no window event is listened to. */
  inline?: boolean | undefined;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The website cache's line (R7's purge, O-3's zone). */
export function cacheWords(status: ReleaseStatusAnswer): { text: string; retry: boolean } {
  if (!status.cacheConnected) return { text: 'Not connected yet', retry: false };
  const purge = status.live?.purge;
  if (purge === 'pending') return { text: 'Refreshing…', retry: false };
  if (purge === 'failed') return { text: 'Couldn’t refresh', retry: true };
  return { text: 'Up to date', retry: false };
}

/** "2 yours to publish · 1 waiting", or "None". */
export function pendingWords(pending: ReleaseStatusAnswer['pending']): string {
  const parts = [
    pending.publishable > 0 ? `${pending.publishable} yours to publish` : null,
    pending.waiting > 0 ? `${pending.waiting} waiting` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'None';
}

export default function PublishCard({ load, retry, inline = false }: PublishCardProps) {
  const clock = useClock();
  const [status, setStatus] = useState<ReleaseStatusAnswer | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setStatus(await load());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [load]);

  useEffect(() => {
    void refresh();
    if (inline) return;
    let timer = 0;
    const soon = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), 300);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') soon();
    };
    window.addEventListener(PENDING_EVENT, soon);
    window.addEventListener('focus', soon);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(PENDING_EVENT, soon);
      window.removeEventListener('focus', soon);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [inline, refresh]);

  async function retryPurge(id: string) {
    setBusy(true);
    setError('');
    try {
      const out = await retry(id);
      if (out.purge === 'failed') {
        setError('The website cache still couldn’t be refreshed. It’s tried again by itself.');
      } else {
        toast('The website cache was refreshed.', 'ok');
      }
      void refresh();
    } catch (err) {
      setError(refusalOf(err).detail ?? 'The website cache couldn’t be refreshed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (failed && !status) {
    return (
      <p className="msg" data-kind="error">
        Publishing’s status couldn’t be read. Reload the page to try again.
      </p>
    );
  }
  if (!status) return <p className="admin-sub">Loading…</p>;

  const live = status.live;
  const cache = cacheWords(status);
  const next = status.next;
  return (
    <div className="pubcard">
      <dl className="stat-rows">
        <div className="stat-row">
          <dt>Live version</dt>
          <dd>
            {live ? `v${live.number}` : 'None yet'}
            {live && (
              <span className="pubcard__by" dir="auto">
                {[
                  live.publishedAt ? `Published ${clock.relTime(live.publishedAt)}` : 'Published',
                  live.publishedBy?.name ? `by ${live.publishedBy.name}` : null,
                ]
                  .filter(Boolean)
                  .join(' ')}
                {live.note ? `: ${live.note}` : ''}
              </span>
            )}
          </dd>
        </div>
        <div className="stat-row">
          <dt>Unpublished changes</dt>
          <dd>
            {pendingWords(status.pending)}{' '}
            <Badge tone={status.pending.publishable + status.pending.waiting > 0 ? 'warn' : 'gray'}>
              {status.pending.publishable + status.pending.waiting > 0 ? 'Yes' : 'None'}
            </Badge>
          </dd>
        </div>
        <div className="stat-row">
          <dt>Next scheduled</dt>
          <dd>
            {next
              ? `${clock.formatDateTime(next.scheduledFor)} · ${plural(next.changes, 'change')}`
              : 'Nothing scheduled'}
          </dd>
        </div>
        <div className="stat-row">
          <dt>Website cache</dt>
          <dd>{cache.text}</dd>
        </div>
        <div className="stat-row">
          <dt>Maintenance</dt>
          <dd>{status.maintenance === null ? 'Unknown' : status.maintenance ? 'On' : 'Off'}</dd>
        </div>
      </dl>
      {status.failed > 0 && (
        <p className="msg pubcard__line" data-kind="error">
          {plural(status.failed, 'scheduled release')} couldn’t go live this week. Its changes are
          waiting to be published again.
        </p>
      )}
      {error && (
        <p className="msg pubcard__line" data-kind="error" role="alert">
          {error}
        </p>
      )}
      <div className="pubcard__acts">
        {status.pending.publishable > 0 && (
          <button
            type="button"
            className="btn"
            data-variant="primary"
            onClick={() => openPublishDialog()}
          >
            Publish now
          </button>
        )}
        {cache.retry && live && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void retryPurge(live.id)}
          >
            Retry<span className="visually-hidden"> refreshing the website cache</span>
          </button>
        )}
        <a className="btn" data-variant="ghost" href="/admin/backups">
          {next || status.failed > 0 ? 'Manage' : 'Versions'}
          <span className="visually-hidden"> on Backups &amp; versions</span>
        </a>
      </div>
    </div>
  );
}
