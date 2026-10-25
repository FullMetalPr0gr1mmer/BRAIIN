import { useEffect, useId, useMemo, useRef, useState } from 'react';
import Modal from '@/components/admin/kit/Modal';
import { Badge } from '@/components/admin/kit/StatusBadge';
import { useClock } from '@/components/admin/kit/clock';
import type { Role } from '@/lib/auth/types';
import { confirmDialog } from '@/lib/admin/confirm';
import { toast } from '@/lib/admin/toast';
import {
  RELEASE_NOTE_MAX,
  type CompareResult,
  type PublishResult,
  type ReleaseCheck,
} from '@schemas/release';
import { refusalOf, type ReleaseApi, type ReleaseRefusal } from './api';
import { CompareRows } from './CompareRows';
import {
  AREA_WORDS,
  CHANGE_TONES,
  CHANGE_WORDS,
  COPY,
  EDGE_MISSED,
  buildRows,
  defaultScheduleSlot,
  defaultSelection,
  discardSelectedWords,
  includedBecause,
  mayDiscard,
  needsOf,
  previewHref,
  publishedWords,
  refsOf,
  rowCheck,
  rowOfDraft,
  rowsByArea,
  scheduleDayBounds,
  scheduledWords,
  scheduleInstant,
  scheduleProblem,
  selectedRows,
  toggleRow,
  waitingWords,
  whoWords,
  withNeeds,
  zoneWords,
  type ChangeRow,
  type PendingSummary,
  type When,
} from './model';

// The publish dialog (Admin v2 R12; releases.md §7 "Publish dialog", README P-2 and P-15,
// owner default O-4): the same dialog the savebar, E1's page editor and R13's dashboard open.
//   - Publish: every change the person may publish is ticked (at most one release, 60
//     changes); each row says what it is (a badge), what it changes, who and when, and what
//     the check says (Ready, a warning, an error with Fix, a conflict with Keep my version,
//     Use the live version and Compare). A change the selection needs is ticked with it
//     ("Included because 'X' needs it"), and unticking one unticks what needs it. What
//     waits for another role is listed, not tickable: "Needs an Admin". The check runs on
//     every selection (POST /api/admin/releases/validate, the database's dry run once the
//     Worker finds nothing to fix); Publish waits for a clean check, and the server decides
//     again. A note of at most 280 characters goes with it. Preview selection opens the site
//     with exactly the ticked changes (R9's `only`).
//   - Review (nothing of mine to publish): the same list, read only.
//   - Discard ("Choose…"): tick what to throw away, a confirm that names other people's.
// Outcomes: a published release is a toast (success only) unless the cache or the edge still
// owe it, then the dialog says so and stays; every refusal is said in the dialog, on its rows
// where it names them, never as a toast.
// When: Now, or Schedule for a day and a time on the studio's clock (Riyadh by default; R11's
// `scheduleAt`, sent as an instant): the same checks, then the changes are stored on a
// scheduled release and locked until it goes live ("Scheduled for 12 Oct 2026, 14:00
// (Riyadh). These changes are locked until then."). A time too soon or too far is said under
// the time, by the dialog first and by the endpoint again.
// Every id is this dialog's own (useId): with releases on, /admin/kit draws two of them, the
// layout's and the kit card's.

export type DialogMode = 'publish' | 'review' | 'discard';

export interface PublishDialogProps {
  open: boolean;
  mode: DialogMode;
  role: Role;
  api: ReleaseApi;
  summary: PendingSummary | null;
  /** E1: scroll to and mark this item's changes. */
  focusEntityId?: string | null | undefined;
  onClose: () => void;
  /** The pending changes moved (a publish, a discard, a settled conflict): read them again. */
  onChanged: () => void;
}

interface Outcome {
  words: string;
  edgeMissed: boolean;
}

/** A refusal in the dialog's words (the server's own where it gives them). */
function refusalWords(refusal: ReleaseRefusal): string {
  if (refusal.error === 'releases-off') return COPY.releasesOff;
  if (refusal.error === 'busy') return refusal.detail ?? COPY.busy;
  if (refusal.error === 'pending-changed') return COPY.pendingChanged;
  if (refusal.status === 403) {
    return refusal.detail ?? 'Your role can’t publish some of these changes. Ask an Admin.';
  }
  if (refusal.status === 0) return 'The admin could not reach the server. Try again.';
  return refusal.detail ?? 'Something went wrong. Try again.';
}

export default function PublishDialog({
  open,
  mode,
  role,
  api,
  summary,
  focusEntityId,
  onClose,
  onChanged,
}: PublishDialogProps) {
  const clock = useClock();
  const uid = useId();
  const rows = useMemo(() => buildRows(summary?.items ?? []), [summary]);
  const [ids, setIds] = useState<Set<string>>(() => new Set());
  const [capped, setCapped] = useState(false);
  const [check, setCheck] = useState<ReleaseCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState('');
  const [refused, setRefused] = useState<ReadonlyMap<string, string>>(new Map());
  const [note, setNote] = useState('');
  const [working, setWorking] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [compares, setCompares] = useState<ReadonlyMap<string, CompareResult>>(new Map());
  // The changes the person unticked themselves: never ticked back for a dependant, which
  // leaves with them instead (model.ts withNeeds); and what left that way, said once.
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const [leftWith, setLeftWith] = useState('');
  // When it goes live: now, or at a day and a time on the studio's clock.
  const [when, setWhen] = useState<When>('now');
  const [slot, setSlot] = useState<{ day: string; time: string }>({ day: '', time: '' });
  const [whenError, setWhenError] = useState('');
  const openedRef = useRef(false);
  const seededRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  // What each change needs, as every check of this dialog has said it (a check over a
  // selection that already holds what a change needs says nothing of it): so a change ticked
  // because another needs it keeps saying why, and unticking it unticks its dependants at once.
  const [needs, setNeeds] = useState<ReadonlyMap<string, readonly string[]>>(new Map());
  const known = useMemo(
    () => new Set(rows.flatMap((row) => row.items.map((item) => item.draftId))),
    [rows],
  );

  // Opening: a fresh selection (publish: everything mine to publish; discard: nothing), made
  // once the summary is there (the dialog can open before the first read lands).
  useEffect(() => {
    if (!open) {
      openedRef.current = false;
      seededRef.current = false;
      return;
    }
    if (!openedRef.current) {
      openedRef.current = true;
      setNotice('');
      setRefused(new Map());
      setOutcome(null);
      setCompares(new Map());
      setCheck(null);
      setNote('');
      setUnticked(new Set());
      setLeftWith('');
      setNeeds(new Map());
      setWhen('now');
      setSlot({ day: '', time: '' });
      setWhenError('');
    }
    if (seededRef.current || summary === null) return;
    seededRef.current = true;
    if (mode === 'publish') {
      const first = defaultSelection(rows);
      setIds(first.ids);
      setCapped(first.capped);
    } else {
      setIds(new Set());
      setCapped(false);
    }
  }, [open, mode, rows, summary]);

  // The pending changes were read again: keep only the ticks that still exist.
  useEffect(() => {
    setIds((current) => {
      const kept = new Set([...current].filter((id) => known.has(id)));
      return kept.size === current.size ? current : kept;
    });
  }, [known]);

  // E1: the item asked for, in view.
  useEffect(() => {
    if (!open || !focusEntityId) return;
    const frame = window.requestAnimationFrame(() => {
      listRef.current?.querySelector('[data-focus]')?.scrollIntoView({ block: 'nearest' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, focusEntityId, rows]);

  // The check, on every selection (debounced): what it needs is ticked and checked again.
  const selection = useMemo(() => refsOf(rows, ids), [rows, ids]);
  const selectionKey = selection.map((r) => `${r.draftId}@${r.draftVersion}`).join(',');
  useEffect(() => {
    if (!open || mode !== 'publish' || selection.length === 0) {
      setCheck(null);
      setChecking(false);
      return;
    }
    let live = true;
    setChecking(true);
    const timer = window.setTimeout(() => {
      api
        .validate({ items: selection })
        .then((result) => {
          if (!live) return;
          setCheck(result);
          setRefused(new Map());
          const merged = new Map(needs);
          for (const [dependant, needed] of needsOf(result)) merged.set(dependant, needed);
          setNeeds(merged);
          const grown = withNeeds(rows, ids, merged, unticked);
          if (grown.added.length > 0 || grown.dropped.length > 0) setIds(grown.ids);
          if (grown.dropped.length > 0) {
            const names = [
              ...new Set(grown.dropped.map((d) => rowOfDraft(rows, d)?.label ?? 'A change')),
            ].map((label) => `“\u2068${label}\u2069”`);
            setLeftWith(
              `${names.join(' and ')} left the selection too: ${names.length === 1 ? 'it needs' : 'they need'} a change you unticked.`,
            );
          }
        })
        .catch((err: unknown) => {
          if (!live) return;
          handleRefusal(refusalOf(err));
        })
        .finally(() => {
          if (live) setChecking(false);
        });
    }, 350);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
    // `selectionKey` stands for the selection and its versions (the effect reads them).
  }, [open, mode, selectionKey]);

  function handleRefusal(refusal: ReleaseRefusal) {
    const body = refusal.body;
    // The endpoint's own judgement of the time (its clock, not the browser's): under the time.
    if (refusal.status === 422 && body['field'] === 'scheduleAt') {
      setWhenError(refusal.detail ?? COPY.scheduleTooSoon);
      setNotice('');
      return;
    }
    if (refusal.status === 403 && Array.isArray(body['draftIds'])) {
      const waiting = (body['waitingFor'] ?? {}) as Record<string, string[]>;
      setRefused(
        new Map(
          (body['draftIds'] as string[]).map((id) => [
            id,
            `Your role can’t publish this. Ask ${whoWords((waiting[id] ?? []) as Role[])}.`,
          ]),
        ),
      );
      setNotice('');
      return;
    }
    const reported = body['check'];
    if (reported && typeof reported === 'object') {
      setCheck(reported as ReleaseCheck);
      setNotice('');
      return;
    }
    if (refusal.error === 'pending-changed') onChanged();
    setNotice(refusalWords(refusal));
  }

  function chooseWhen(next: When) {
    setWhen(next);
    setWhenError('');
    if (next === 'schedule' && !slot.day && !slot.time) {
      setSlot(defaultScheduleSlot(clock.zone, Date.now()));
    }
  }

  async function publish() {
    if (selection.length === 0) return;
    let scheduleAt: string | undefined;
    if (when === 'schedule') {
      const at = scheduleInstant(clock.zone, slot.day, slot.time);
      const problem = scheduleProblem(at, Date.now());
      if (problem !== null || at === null) {
        setWhenError(problem ?? COPY.scheduleIncomplete);
        return;
      }
      scheduleAt = at.toISOString();
    }
    setWorking(true);
    setNotice('');
    setWhenError('');
    try {
      const trimmed = note.trim();
      const request = { items: selection, ...(trimmed ? { note: trimmed } : {}) };
      if (scheduleAt !== undefined) {
        const scheduled = await api.schedule({ ...request, scheduleAt });
        onChanged();
        toast(scheduledWords(scheduled.release.scheduledFor, clock), 'ok');
        onClose();
        return;
      }
      const result: PublishResult = await api.publish(request);
      onChanged();
      const words = publishedWords(result.release.number, result.purge);
      const edgeMissed = result.kvSynced === false;
      if (edgeMissed || result.purge === 'failed') {
        setOutcome({ words, edgeMissed });
      } else {
        toast(words, 'ok');
        onClose();
      }
    } catch (err) {
      handleRefusal(refusalOf(err));
    } finally {
      setWorking(false);
    }
  }

  async function discardChosen() {
    if (selection.length === 0) return;
    const ok = await confirmDialog({
      message: discardSelectedWords(rows, ids),
      confirmLabel: 'Discard',
    });
    if (!ok) return;
    setWorking(true);
    setNotice('');
    try {
      const result = await api.discard({ items: selection });
      onChanged();
      toast(
        `${result.discarded} unpublished ${result.discarded === 1 ? 'change' : 'changes'} thrown away.`,
        'ok',
      );
      onClose();
    } catch (err) {
      handleRefusal(refusalOf(err));
    } finally {
      setWorking(false);
    }
  }

  async function settle(
    draftId: string,
    version: number,
    choice: 'keepMine' | 'useLive',
    columns: readonly string[],
  ) {
    setWorking(true);
    setNotice('');
    try {
      await api.resolve(draftId, { version, [choice]: [...columns] });
      setCompares((current) => {
        const next = new Map(current);
        next.delete(draftId);
        return next;
      });
      onChanged();
    } catch (err) {
      setNotice(refusalWords(refusalOf(err)));
    } finally {
      setWorking(false);
    }
  }

  async function toggleCompare(draftId: string) {
    if (compares.has(draftId)) {
      setCompares((current) => {
        const next = new Map(current);
        next.delete(draftId);
        return next;
      });
      return;
    }
    try {
      const result = await api.compare(draftId);
      setCompares((current) => new Map(current).set(draftId, result));
    } catch (err) {
      setNotice(refusalWords(refusalOf(err)));
    }
  }

  const tickable = (row: ChangeRow) =>
    mode === 'publish'
      ? row.publishable
      : mode === 'discard'
        ? !row.scheduled && row.items.every((item) => mayDiscard(role, item))
        : false;

  const groups = rowsByArea(rows);
  // Rows, as the bar counts them (a reordered list is one change).
  const count = selectedRows(rows, ids);
  const ready = mode === 'publish' && check !== null && check.ok && !checking;
  const title =
    mode === 'publish'
      ? COPY.publishTitle
      : mode === 'discard'
        ? COPY.discardTitle
        : COPY.reviewTitle;
  const sub =
    mode === 'publish' ? COPY.publishSub : mode === 'discard' ? COPY.discardSub : COPY.reviewSub;
  const plural = (n: number) => `${n} ${n === 1 ? 'change' : 'changes'}`;
  // The day input's range (today to a year ahead, on the studio's clock), only when drawn.
  const bounds =
    when === 'schedule' ? scheduleDayBounds(clock.zone, Date.now()) : { min: '', max: '' };

  const footer = outcome ? (
    <button type="button" data-variant="primary" onClick={onClose}>
      Close
    </button>
  ) : (
    <>
      <button type="button" data-autofocus="" onClick={onClose}>
        {mode === 'review' ? 'Close' : 'Cancel'}
      </button>
      {mode !== 'discard' && (
        <a
          className="btn"
          href={previewHref(mode === 'publish' ? ids : known)}
          target="_blank"
          rel="noopener"
        >
          {mode === 'publish' ? 'Preview selection' : 'Preview'}
        </a>
      )}
      {mode === 'publish' && (
        <button
          type="button"
          data-variant="primary"
          disabled={!ready || working || count === 0}
          onClick={() => void publish()}
        >
          {when === 'schedule'
            ? working
              ? 'Scheduling…'
              : `Schedule ${plural(count)}`
            : working
              ? 'Publishing…'
              : `Publish ${plural(count)}`}
        </button>
      )}
      {mode === 'discard' && (
        <button
          type="button"
          data-variant="danger"
          disabled={working || count === 0}
          onClick={() => void discardChosen()}
        >
          {`Discard ${plural(count)}`}
        </button>
      )}
    </>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      sub={sub}
      size="lg"
      dismissible={false}
      footer={footer}
    >
      <div className="pub" ref={listRef}>
        {outcome && (
          <div className="pub__outcome" role="status">
            <p>{outcome.words}</p>
            {outcome.edgeMissed && (
              <p className="msg" data-kind="error">
                {EDGE_MISSED}
              </p>
            )}
          </div>
        )}
        {!outcome && notice && (
          <p className="msg" data-kind="error" role="alert">
            {notice}
          </p>
        )}
        {!outcome && capped && mode === 'publish' && <p className="pub__capped">{COPY.capped}</p>}
        {!outcome && leftWith && (
          <p className="pub__capped" role="status">
            {leftWith}
          </p>
        )}
        {!outcome && rows.length === 0 && <p className="admin-sub">No unpublished changes.</p>}
        {!outcome &&
          groups.map((group) => (
            // A group, not a region: the dialog's areas are no landmarks of the page.
            <div
              key={group.area}
              className="pub__area"
              role="group"
              aria-labelledby={`${uid}-area-${group.area}`}
            >
              <h3 id={`${uid}-area-${group.area}`} className="pub__area-title">
                {AREA_WORDS[group.area]}
              </h3>
              <ul className="pub__rows">
                {group.rows.map((row) => {
                  const state = rowCheck(row, check);
                  const can = tickable(row);
                  const on = row.items.every((item) => ids.has(item.draftId));
                  const inputId = `${uid}-${row.key}`;
                  const metaId = `${inputId}-meta`;
                  const because = includedBecause(rows, ids, row, needs);
                  const refusedWords = row.items
                    .map((item) => refused.get(item.draftId))
                    .find((words) => words !== undefined);
                  const focus =
                    focusEntityId !== undefined &&
                    focusEntityId !== null &&
                    row.items.some((item) => item.entityId === focusEntityId);
                  const rowState =
                    !can && mode === 'publish'
                      ? 'waiting'
                      : refusedWords
                        ? 'error'
                        : on && mode === 'publish'
                          ? checking && state.state === 'unchecked'
                            ? 'checking'
                            : state.state
                          : 'idle';
                  const author = row.author ?? 'Someone';
                  const when = clock.relTime(row.updatedAt);
                  const conflictDraft = state.conflict?.draftId;
                  const conflictItem = row.items.find((item) => item.draftId === conflictDraft);
                  return (
                    <li
                      key={row.key}
                      className="pub__row"
                      data-state={rowState}
                      data-focus={focus ? '' : undefined}
                    >
                      <span className="pub__tick">
                        {can ? (
                          <input
                            type="checkbox"
                            id={inputId}
                            checked={on}
                            aria-describedby={metaId}
                            onChange={(event) => {
                              const on = event.target.checked;
                              const drafts = row.items.map((item) => item.draftId);
                              // A tick is a fresh choice: what it needs may come along again
                              // (the check ticks it, saying why). An untick is remembered, so
                              // the check takes what needs it out instead of ticking it back.
                              setUnticked((current) => {
                                if (on) return new Set();
                                const next = new Set(current);
                                for (const draftId of drafts) next.add(draftId);
                                return next;
                              });
                              setLeftWith('');
                              setIds(toggleRow(rows, ids, row, on, needs));
                            }}
                          />
                        ) : null}
                      </span>
                      <div className="pub__main">
                        <div className="pub__head">
                          {can ? (
                            <label htmlFor={inputId} className="pub__label" dir="auto">
                              {row.label}
                            </label>
                          ) : (
                            <span className="pub__label" dir="auto">
                              {row.label}
                            </span>
                          )}
                          {row.labelAr && (
                            <span className="pub__label-ar" lang="ar" dir="rtl">
                              {row.labelAr}
                            </span>
                          )}
                          <Badge tone={CHANGE_TONES[row.kind]}>{CHANGE_WORDS[row.kind]}</Badge>
                        </div>
                        <p className="pub__meta" id={metaId}>
                          {[row.fieldsText, `${author}, ${when}`].filter(Boolean).join(' · ')}
                        </p>
                        {/* What waits says who can publish it (P-2): in review too, where
                            every row waits. */}
                        {mode !== 'discard' && !can && (
                          <p className="pub__status">{waitingWords(row)}</p>
                        )}
                        {mode === 'discard' && !can && (
                          <p className="pub__status">
                            {row.scheduled ? waitingWords(row) : 'Your role can’t throw this away.'}
                          </p>
                        )}
                        {because && <p className="pub__status">{because}</p>}
                        {refusedWords && <p className="pub__status">{refusedWords}</p>}
                        {mode === 'publish' && can && on && !refusedWords && (
                          <div className="pub__status">
                            {rowState === 'checking' && <span>{COPY.checking}</span>}
                            {rowState === 'ready' && <span>{COPY.ready}</span>}
                            {(rowState === 'warning' || rowState === 'error') &&
                              state.messages.map((message) => <p key={message}>{message}</p>)}
                            {rowState === 'error' && row.href && (
                              <a href={row.href} className="pub__fix">
                                Fix
                              </a>
                            )}
                            {rowState === 'conflict' && state.removed && <p>{COPY.removedLive}</p>}
                            {rowState === 'conflict' && state.conflict && conflictItem && (
                              <>
                                <p>{COPY.conflictLead}.</p>
                                <div className="toolbar">
                                  <button
                                    type="button"
                                    disabled={working}
                                    onClick={() =>
                                      void settle(
                                        conflictItem.draftId,
                                        conflictItem.draftVersion,
                                        'keepMine',
                                        state.conflict!.columns,
                                      )
                                    }
                                  >
                                    Keep my version
                                  </button>
                                  <button
                                    type="button"
                                    disabled={working}
                                    onClick={() =>
                                      void settle(
                                        conflictItem.draftId,
                                        conflictItem.draftVersion,
                                        'useLive',
                                        state.conflict!.columns,
                                      )
                                    }
                                  >
                                    Use the live version
                                  </button>
                                  <button
                                    type="button"
                                    aria-expanded={compares.has(conflictItem.draftId)}
                                    onClick={() => void toggleCompare(conflictItem.draftId)}
                                  >
                                    Compare
                                  </button>
                                </div>
                                {compares.get(conflictItem.draftId) && (
                                  <CompareRows result={compares.get(conflictItem.draftId)!} />
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        {!outcome && mode === 'publish' && (
          <div className="field pub__note">
            <label htmlFor={`${uid}-note`}>{COPY.noteLabel}</label>
            <textarea
              id={`${uid}-note`}
              rows={2}
              maxLength={RELEASE_NOTE_MAX}
              value={note}
              aria-describedby={`${uid}-note-count`}
              onChange={(event) => setNote(event.target.value)}
            />
            <p className="admin-sub" id={`${uid}-note-count`}>
              {note.length}/{RELEASE_NOTE_MAX}
            </p>
          </div>
        )}
        {!outcome && mode === 'publish' && (
          // A plain fieldset: its legend keeps the browser's own layout (never floated beside
          // a flex row), and the choice is native radios (the arrow keys are the browser's).
          <fieldset className="pub__when">
            <legend className="field-legend">{COPY.whenLegend}</legend>
            <div className="seg">
              {(['now', 'schedule'] as const).map((value) => (
                <label key={value} className="seg__o">
                  <input
                    type="radio"
                    name={`${uid}-when`}
                    value={value}
                    checked={when === value}
                    onChange={() => chooseWhen(value)}
                  />
                  {value === 'now' ? COPY.whenNow : COPY.whenSchedule}
                </label>
              ))}
            </div>
            {when === 'schedule' && (
              <div className="pub__slot">
                <div className="field">
                  <label htmlFor={`${uid}-day`}>{COPY.dayLabel}</label>
                  <input
                    type="date"
                    id={`${uid}-day`}
                    value={slot.day}
                    min={bounds.min}
                    max={bounds.max}
                    required
                    aria-invalid={whenError ? true : undefined}
                    aria-describedby={whenError ? `${uid}-when-error` : undefined}
                    onChange={(event) => {
                      setSlot({ ...slot, day: event.target.value });
                      setWhenError('');
                    }}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`${uid}-time`}>{COPY.timeLabel}</label>
                  <input
                    type="time"
                    id={`${uid}-time`}
                    value={slot.time}
                    required
                    aria-invalid={whenError ? true : undefined}
                    aria-describedby={
                      whenError ? `${uid}-when-zone ${uid}-when-error` : `${uid}-when-zone`
                    }
                    onChange={(event) => {
                      setSlot({ ...slot, time: event.target.value });
                      setWhenError('');
                    }}
                  />
                </div>
                <p className="admin-sub pub__zone" id={`${uid}-when-zone`}>
                  {zoneWords(clock.zone)}
                </p>
              </div>
            )}
            {whenError && (
              <p className="msg" data-kind="error" id={`${uid}-when-error`} role="alert">
                {whenError}
              </p>
            )}
          </fieldset>
        )}
      </div>
    </Modal>
  );
}
