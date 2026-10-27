import { useEffect, useId, useState } from 'react';
import Modal from '@/components/admin/kit/Modal';
import Note from '@/components/admin/kit/Note';
import { Badge } from '@/components/admin/kit/StatusBadge';
import { useClock } from '@/components/admin/kit/clock';
import { confirmDialog } from '@/lib/admin/confirm';
import { FLASH_MESSAGES, showFlash, withFlash, type FlashKey } from '@/lib/admin/flash';
import { announcePending, openPublishDialog } from '@/lib/admin/releaseEvents';
import { toast } from '@/lib/admin/toast';
import type { OpenRestore } from '@/lib/release/versionsPage';
import { refusalOf } from '@/components/admin/screens/release/api';
import {
  COPY as RELEASE_COPY,
  scheduleDayBounds,
  scheduleInstant,
  scheduleProblem,
  slotOf,
  zoneWords,
} from '@/components/admin/screens/release/model';
import type { VersionsApi } from './api';
import {
  COPY,
  byLine,
  changesLine,
  failedLine,
  kindLine,
  purgeLine,
  refusedNames,
  scheduledTitle,
  versionName,
  type VersionSummary,
} from './model';

// The versions card of Backups & versions (Admin v2 R13; releases.md §7 "Versions page"): what
// is scheduled or failed on top, then every published version, newest first, the live one
// marked. Drawn only while releases are on (the page says so otherwise, with no script). Each
// action asks the server, which decides again (the kernel, each change's own capabilities, RLS):
//   Restore         R10's restore: the version's content staged as pending changes; then the
//                   row offers "Publish vN again", R10's rollback (every change of that
//                   restore, untouched), never a toast for a refusal (said on the row);
//   Change time,    R11's move and cancel of a scheduled release (the day and the time on the
//   Unschedule      studio's clock, as the publish dialog's When);
//   Review          a failed release's changes are pending again: R12's publish dialog;
//   Retry           R13's purge retry for a version whose cache purge failed.
// Preview and Details are links (R9's `?v=N`, the page's own `?details=`). The kit gallery
// draws this over made-up versions (sampleVersions), with an API that sends nothing.

export interface VersionsProps {
  api: VersionsApi;
  versions: readonly VersionSummary[];
  upcoming: readonly VersionSummary[];
  restores: Readonly<Record<string, OpenRestore>>;
  more: boolean;
  /** The kit's gallery: no confirmation is read from the address, and no action reloads. */
  inline?: boolean | undefined;
}

type RowError = { text: string; names: string[]; publish?: boolean };

export default function Versions({
  api,
  versions,
  upcoming,
  restores: initialRestores,
  more,
  inline = false,
}: VersionsProps) {
  const clock = useClock();
  const uid = useId();
  const [restores, setRestores] = useState<Record<string, OpenRestore>>({ ...initialRestores });
  const [purges, setPurges] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, RowError>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [moving, setMoving] = useState<VersionSummary | null>(null);
  const [slot, setSlot] = useState({ day: '', time: '' });
  const [slotError, setSlotError] = useState('');

  useEffect(() => {
    if (!inline) showFlash();
  }, [inline]);

  /** Read the list again, with a confirmation that survives the navigation (the kit: a toast). */
  const reload = (key: FlashKey) => {
    if (inline) toast(FLASH_MESSAGES[key], 'ok');
    else window.location.assign(withFlash(window.location.pathname, key));
  };

  async function run(id: string, work: () => Promise<void>) {
    setBusy(id);
    setErrors(({ [id]: _gone, ...rest }) => rest);
    try {
      await work();
    } catch (err) {
      const refusal = refusalOf(err);
      setErrors((all) => ({
        ...all,
        [id]: {
          text:
            refusal.detail ??
            (refusal.status === 403 ? COPY.forbidden : 'That didn’t work. Try again in a moment.'),
          names: refusedNames(refusal.body),
        },
      }));
    } finally {
      setBusy(null);
    }
  }

  const restore = (v: VersionSummary) =>
    run(v.id, async () => {
      const n = v.number ?? 0;
      if (
        !(await confirmDialog({
          message: `${COPY.restoreTitle(n)} ${COPY.restoreBody}`,
          confirmLabel: 'Restore',
          danger: false,
        }))
      )
        return;
      const result = await api.restore(v.id);
      setRestores((all) => ({
        ...all,
        [v.id]: {
          items: result.staged.map((s) => ({ draftId: s.draftId, draftVersion: s.draftVersion })),
          untouched: result.marked,
        },
      }));
      announcePending();
      toast(COPY.restored(n), 'ok');
    });

  const publishAgain = (v: VersionSummary, open: OpenRestore) =>
    run(v.id, async () => {
      const n = v.number ?? 0;
      if (
        !(await confirmDialog({
          message: COPY.publishAgainBody(n, open.items.length),
          confirmLabel: COPY.publishAgain(n),
          danger: false,
        }))
      )
        return;
      try {
        await api.publishRollback(open.items);
      } catch (err) {
        const refusal = refusalOf(err);
        // A check that names changes is the dialog's to show, change by change.
        if (refusal.status === 422 && refusal.body['field'] !== 'kind') {
          setErrors((all) => ({
            ...all,
            [v.id]: { text: COPY.publishAgainRefused, names: [], publish: true },
          }));
          return;
        }
        throw err;
      }
      announcePending();
      reload('version-published');
    });

  const unschedule = (v: VersionSummary) =>
    run(v.id, async () => {
      if (
        !(await confirmDialog({
          message: COPY.unscheduleBody(v.itemCount),
          confirmLabel: 'Unschedule',
        }))
      )
        return;
      await api.unschedule(v.id, v.version);
      announcePending();
      reload('release-unscheduled');
    });

  const retry = (v: VersionSummary) =>
    run(v.id, async () => {
      const out = await api.retryPurge(v.id);
      setPurges((all) => ({ ...all, [v.id]: out.purge }));
      if (out.purge === 'failed') throw new Error(COPY.purgeFailed);
      toast(out.purge === 'skipped' ? COPY.purgeSkipped : COPY.purgeDone, 'ok');
    });

  function openMove(v: VersionSummary) {
    setSlot(v.scheduledFor ? slotOf(new Date(v.scheduledFor), clock.zone) : { day: '', time: '' });
    setSlotError('');
    setMoving(v);
  }

  async function move() {
    const v = moving;
    if (!v) return;
    const at = scheduleInstant(clock.zone, slot.day, slot.time);
    const problem = scheduleProblem(at, Date.now());
    if (problem || !at) {
      setSlotError(problem ?? RELEASE_COPY.scheduleIncomplete);
      return;
    }
    setBusy(v.id);
    try {
      await api.reschedule(v.id, v.version, at.toISOString());
      setMoving(null);
      reload('release-moved');
    } catch (err) {
      setSlotError(refusalOf(err).detail ?? 'The time couldn’t be changed. Try again.');
    } finally {
      setBusy(null);
    }
  }

  const rowError = (id: string) => {
    const error = errors[id];
    if (!error) return null;
    return (
      <div className="msg ver__err" data-kind="error" role="alert">
        <p>{error.text}</p>
        {error.names.length > 0 && (
          <ul className="ver__names">
            {error.names.map((name) => (
              <li key={name} dir="auto">
                {name}
              </li>
            ))}
          </ul>
        )}
        {error.publish && (
          <button type="button" className="btn" onClick={() => openPublishDialog()}>
            Open Publish
          </button>
        )}
      </div>
    );
  };

  const zone = zoneWords(clock.zone);
  const bounds = scheduleDayBounds(clock.zone, Date.now());

  return (
    <div className="ver">
      {upcoming.length > 0 && (
        <ul className="ver__up" aria-label="Scheduled and failed releases">
          {upcoming.map((v) => (
            <li key={v.id} className="ver__card" data-state={v.status}>
              {v.status === 'scheduled' ? (
                <>
                  <p className="ver__t">
                    <Badge tone="klein">Scheduled</Badge>{' '}
                    {scheduledTitle(v.scheduledFor, clock, zone)}
                  </p>
                  <p className="tl__s">
                    {[changesLine(v), v.scheduledBy?.name ? `by ${v.scheduledBy.name}` : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  <div className="ver__acts">
                    <button
                      type="button"
                      className="btn"
                      disabled={busy === v.id}
                      onClick={() => openMove(v)}
                    >
                      {COPY.changeTime}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy === v.id}
                      onClick={() => void unschedule(v)}
                    >
                      Unschedule
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="ver__t">
                    <Badge tone="err">Failed</Badge> {failedLine(v, clock)}
                  </p>
                  <div className="ver__acts">
                    <button type="button" className="btn" onClick={() => openPublishDialog()}>
                      {COPY.failedRetry}
                    </button>
                  </div>
                </>
              )}
              {rowError(v.id)}
            </li>
          ))}
        </ul>
      )}

      {versions.length === 0 ? (
        <p className="admin-sub">{COPY.noVersions}</p>
      ) : (
        <ol className="tl ver__tl" aria-label="Published versions">
          {versions.map((v) => {
            const n = v.number ?? 0;
            const kind = kindLine(v);
            const purge = purgeLine(purges[v.id] ?? v.purge);
            const open = restores[v.id];
            return (
              <li key={v.id} className="tl__i" data-live={v.live ? '' : undefined}>
                <p className="tl__t">
                  <span className="ver__n">{versionName(v.number)}</span>
                  {v.live && <Badge tone="ok">Live now</Badge>}
                  {kind && <span className="ver__kind">{kind}</span>}
                </p>
                {v.note && (
                  <p className="tl__s ver__note" dir="auto">
                    {v.note}
                  </p>
                )}
                <p className="tl__s">{byLine(v.publishedBy?.name, v.publishedAt, clock)}</p>
                <p className="tl__s">{changesLine(v)}</p>
                {purge && (
                  <p className="tl__s ver__purge">
                    {purge.text}{' '}
                    {purge.retry && (
                      <button
                        type="button"
                        className="btn"
                        data-size="sm"
                        disabled={busy === v.id}
                        onClick={() => void retry(v)}
                      >
                        Retry
                      </button>
                    )}
                  </p>
                )}
                {open && (
                  <Note className="ver__restored">
                    <p>
                      {open.untouched
                        ? COPY.restoredWaiting(open.items.length)
                        : COPY.restoredEdited}
                    </p>
                    {open.untouched && (
                      <div className="ver__acts">
                        <button
                          type="button"
                          className="btn"
                          data-variant="primary"
                          disabled={busy === v.id}
                          onClick={() => void publishAgain(v, open)}
                        >
                          {COPY.publishAgain(n)}
                        </button>
                        <a
                          className="btn"
                          href={`/admin/preview/?only=${open.items.map((i) => i.draftId).join(',')}`}
                          target="_blank"
                          rel="noopener"
                        >
                          Preview the restore
                          <span className="visually-hidden"> (opens in a new tab)</span>
                        </a>
                      </div>
                    )}
                  </Note>
                )}
                <div className="ver__acts">
                  {!v.live && (
                    <a
                      className="btn"
                      href={`/admin/preview/?v=${n}`}
                      target="_blank"
                      rel="noopener"
                    >
                      Preview
                      <span className="visually-hidden">
                        {' '}
                        {versionName(v.number)} (opens in a new tab)
                      </span>
                    </a>
                  )}
                  <a className="btn" href={`?details=${v.id}#details`}>
                    Details<span className="visually-hidden"> of {versionName(v.number)}</span>
                  </a>
                  {!v.live && !open && (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy === v.id}
                      onClick={() => void restore(v)}
                    >
                      Restore<span className="visually-hidden"> {versionName(v.number)}</span>
                    </button>
                  )}
                </div>
                {rowError(v.id)}
              </li>
            );
          })}
        </ol>
      )}
      {more && versions.length > 0 && (
        <a className="btn" href={`?before=${versions[versions.length - 1]?.number ?? ''}`}>
          Older versions
        </a>
      )}

      <Modal
        open={moving !== null}
        onClose={() => setMoving(null)}
        title={COPY.changeTime}
        sub={COPY.changeTimeSub}
        dismissible={false}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setMoving(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn"
              data-variant="primary"
              disabled={busy !== null}
              onClick={() => void move()}
            >
              {COPY.changeTime}
            </button>
          </>
        }
      >
        <div className="pub__slot">
          <div className="field">
            <label htmlFor={`${uid}-day`}>{RELEASE_COPY.dayLabel}</label>
            <input
              type="date"
              id={`${uid}-day`}
              value={slot.day}
              min={bounds.min}
              max={bounds.max}
              required
              aria-invalid={slotError ? true : undefined}
              aria-describedby={slotError ? `${uid}-err` : undefined}
              onChange={(e) => {
                setSlot({ ...slot, day: e.target.value });
                setSlotError('');
              }}
            />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-time`}>{RELEASE_COPY.timeLabel}</label>
            <input
              type="time"
              id={`${uid}-time`}
              value={slot.time}
              required
              aria-invalid={slotError ? true : undefined}
              aria-describedby={slotError ? `${uid}-zone ${uid}-err` : `${uid}-zone`}
              onChange={(e) => {
                setSlot({ ...slot, time: e.target.value });
                setSlotError('');
              }}
            />
          </div>
          <p className="admin-sub pub__zone" id={`${uid}-zone`}>
            {zone}
          </p>
        </div>
        {slotError && (
          <p className="msg" data-kind="error" id={`${uid}-err`} role="alert">
            {slotError}
          </p>
        )}
      </Modal>
    </div>
  );
}
