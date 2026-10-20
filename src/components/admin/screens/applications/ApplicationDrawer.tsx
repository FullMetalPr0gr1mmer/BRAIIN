import { useEffect, useId, useRef, useState } from 'react';
import {
  APPLICATION_STATUSES,
  CRAFTS,
  SPAM_RETENTION_DAYS,
  optionLabel,
} from '@schemas/application';
import { adminFetch, describeError } from '@/lib/admin/client';
import { confirmDialog } from '@/lib/admin/confirm';
import { formatDate } from '@/lib/admin/relTime';
import { toast } from '@/lib/admin/toast';
import {
  APPLICATION_STATUS_LABEL,
  afterPatch,
  afterReveal,
  detailRows,
  formatBytes,
  isRevealed,
  safeLink,
  statusLabel,
  withoutContact,
  type ApplicationDetail,
} from '@/lib/admin/applicationView';
import Drawer from '@/components/admin/kit/Drawer';
import { Badge } from '@/components/admin/kit/StatusBadge';

// One application in the kit's wide drawer (Admin v2 U8a, ui.md AV-17: the look of the
// prototype's lead detail, cards of label and value rows). Admin only, like the screen:
// RLS (0029, with its live Admin check) and the routes' capabilities decide; this draws.
//
// The personal data, and what each step costs:
//   - Opening reads the application without contact details (`application.view`, no PII).
//   - "Reveal contact details" is the one audited read of the e-mail and phone (`?pii=1`:
//     live recheck, `application.view_pii` written before anything is decrypted). The
//     values then live in this drawer's memory only. A status or notes save answers with
//     the row WITHOUT them, and mergeAfterPatch keeps what was revealed: before U8a every
//     save re-opened the application with `?pii=1`, a second decrypt and a second audit
//     row per save. "Hide" drops them; another application, or closing, forgets them.
//   - "Download CV" is a plain link to the audited, rate-limited download route.
// Discrete controls send one request each (P-5): the status on change (Spam asks first,
// it shortens the retention to 30 days), the notes on "Save notes". Errors stay inline,
// successes are toasts. Every applicant-written text is a text node with dir="auto".
// A request belongs to the application it was sent for: the drawer stays mounted from one
// application to the next, so an answer or a refusal that lands after it moved on is laid
// over nothing else (afterPatch, afterReveal, and `shown` for the error line).

export interface ApplicationDrawerProps {
  /** The application to show; null closes the drawer. */
  id: string | null;
  /** Mirrors `applications.pii`: UX only, the server decides. */
  canSeePii: boolean;
  onClose: () => void;
  /** A status or notes save landed: the list re-reads. */
  onChanged: () => void;
  /** The application was erased: the panel says so and re-reads. */
  onErased: () => void;
}

/** "Erase <name>'s application and CV?": the name a bidi isolate, so Arabic stays in place. */
export function eraseMessage(name: string): string {
  return `Erase ⁨${name}⁩’s application and CV? This cannot be undone.`;
}

export const SPAM_MESSAGE = `Mark as spam? It will be deleted within ${SPAM_RETENTION_DAYS} days.`;
export const LEAVE_MESSAGE = 'Leave without saving the note?';
export const NOTES_MAX = 5000;

export default function ApplicationDrawer({
  id,
  canSeePii,
  onClose,
  onChanged,
  onErased,
}: ApplicationDrawerProps) {
  const [detail, setDetail] = useState<ApplicationDetail | null>(null);
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The drawer is closed while it asks whether to leave an unsaved note (Escape or the
  // header's Close shut the native dialog first); a "no" opens it again.
  const [asking, setAsking] = useState(false);
  const leaving = useRef(false);
  // The application on screen now, for a request that ends after the drawer moved on.
  const shown = useRef(id);
  const statusId = useId();
  const notesId = useId();
  const notesCountId = useId();
  const revealHintId = useId();

  const stored = detail?.internal_notes ?? '';
  const dirty = detail !== null && notes !== stored;

  useEffect(() => {
    shown.current = id;
    setDetail(null);
    setNotes('');
    setError('');
    setAsking(false);
    leaving.current = false;
    if (!id) return;
    const controller = new AbortController();
    setLoading(true);
    adminFetch<ApplicationDetail>(`/api/admin/applications/${id}`, { signal: controller.signal })
      .then((row) => {
        setDetail(row);
        setNotes(row.internal_notes ?? '');
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(describeError(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [id]);

  /** Closes for good: what the footer's Close, an erase and a confirmed leave do. */
  function leave() {
    leaving.current = true;
    onClose();
  }

  async function closeAsked() {
    if (!dirty || (await confirmDialog({ message: LEAVE_MESSAGE, confirmLabel: 'Leave' }))) {
      leave();
    }
  }

  // The native dialog has closed (Escape, the header's Close, or `id` going null).
  async function onDialogClosed() {
    if (leaving.current || !dirty || id === null) {
      leaving.current = false;
      onClose();
      return;
    }
    setAsking(true);
    const go = await confirmDialog({ message: LEAVE_MESSAGE, confirmLabel: 'Leave' });
    if (go) leave();
    else setAsking(false);
  }

  /** A refusal for `forId`, shown only while that application is on screen. */
  function failed(forId: string, err: unknown) {
    if (shown.current === forId) setError(describeError(err));
  }

  async function reveal() {
    if (!detail) return;
    const forId = detail.id;
    setBusy(true);
    setError('');
    try {
      // The one audited read of the contact details (live recheck, audit row first).
      const row = await adminFetch<ApplicationDetail>(`/api/admin/applications/${forId}?pii=1`);
      setDetail((current) => afterReveal(current, row));
    } catch (err) {
      failed(forId, err);
    } finally {
      setBusy(false);
    }
  }

  async function patch(body: { status?: string; internalNotes?: string }, done: string) {
    if (!detail) return false;
    const forId = detail.id;
    setBusy(true);
    setError('');
    try {
      const answer = await adminFetch<Partial<ApplicationDetail>>(
        `/api/admin/applications/${forId}`,
        { method: 'PATCH', body },
      );
      // The answer carries no contact details; what was revealed stays (one audit row). It
      // lands only on the application it was for, whichever the drawer shows by now.
      setDetail((current) => afterPatch(current, forId, answer));
      toast(done, 'ok');
      onChanged();
      return true;
    } catch (err) {
      failed(forId, err);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(next: string) {
    if (!detail || next === detail.status) return;
    if (
      next === 'spam' &&
      !(await confirmDialog({ message: SPAM_MESSAGE, confirmLabel: 'Mark as spam' }))
    ) {
      return;
    }
    await patch({ status: next }, `Status changed to ${statusLabel(next)}.`);
  }

  // What the server stored becomes the baseline (mergeAfterPatch takes internal_notes), so
  // the box is clean again unless more was typed while the save was on its way.
  async function saveNotes() {
    await patch({ internalNotes: notes }, 'Notes saved.');
  }

  async function erase() {
    if (!detail) return;
    if (!(await confirmDialog({ message: eraseMessage(detail.name), confirmLabel: 'Erase' }))) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await adminFetch(`/api/admin/applications/${detail.id}`, { method: 'DELETE' });
      leaving.current = true;
      onErased();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  const revealed = isRevealed(detail);
  const portfolio = safeLink(detail?.portfolio_url);
  const linkedin = safeLink(detail?.linkedin_url);

  return (
    <Drawer
      open={id !== null && !asking}
      onClose={() => void onDialogClosed()}
      title={detail?.name ?? 'Application'}
      size="wide"
      dismissible={!dirty}
      footer={
        <div className="app-drawer__acts">
          {detail && (
            <button
              type="button"
              data-variant="danger"
              disabled={busy}
              onClick={() => void erase()}
            >
              Erase application
            </button>
          )}
          <button type="button" onClick={() => void closeAsked()}>
            Close
          </button>
        </div>
      }
    >
      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}
      {loading && !detail && <p className="admin-sub">Loading…</p>}
      {detail && (
        <div className="app-drawer">
          <section className="card" aria-labelledby={`${statusId}-message`}>
            <h3 className="card-title" id={`${statusId}-message`}>
              Message
            </h3>
            <p className="prewrap app-drawer__message" dir="auto">
              {detail.message}
            </p>
          </section>

          <section className="card" aria-labelledby={`${statusId}-details`}>
            <h3 className="card-title" id={`${statusId}-details`}>
              Details
            </h3>
            <dl className="stat-rows">
              {detailRows(detail).map(([label, value]) => (
                <div className="stat-row" key={label}>
                  <dt>{label}</dt>
                  <dd dir="auto">{value}</dd>
                </div>
              ))}
              <div className="stat-row">
                <dt>Crafts</dt>
                <dd>
                  {detail.skills.length > 0 ? (
                    <span className="app-drawer__crafts">
                      {detail.skills.map((skill) => (
                        <Badge key={skill} tone="gray" plain>
                          {optionLabel(CRAFTS, skill)}
                        </Badge>
                      ))}
                    </span>
                  ) : (
                    'None chosen'
                  )}
                </dd>
              </div>
              <div className="stat-row">
                <dt>Portfolio</dt>
                <dd className="app-drawer__link">
                  {portfolio ? (
                    <a href={portfolio} target="_blank" rel="noopener noreferrer" dir="ltr">
                      {portfolio}
                    </a>
                  ) : (
                    'Not given'
                  )}
                </dd>
              </div>
              <div className="stat-row">
                <dt>LinkedIn</dt>
                <dd className="app-drawer__link">
                  {linkedin ? (
                    <a href={linkedin} target="_blank" rel="noopener noreferrer" dir="ltr">
                      {linkedin}
                    </a>
                  ) : (
                    'Not given'
                  )}
                </dd>
              </div>
            </dl>
          </section>

          {canSeePii && (
            <section className="card" aria-labelledby={`${statusId}-contact`}>
              <h3 className="card-title" id={`${statusId}-contact`}>
                Contact details
              </h3>
              {revealed ? (
                <>
                  <dl className="pii">
                    <dt>E-mail</dt>
                    <dd>
                      {detail.email ? (
                        <a href={`mailto:${detail.email}`} dir="ltr">
                          {detail.email}
                        </a>
                      ) : (
                        'Not given'
                      )}
                    </dd>
                    <dt>Phone</dt>
                    <dd>
                      {detail.phone ? (
                        <a href={`tel:${detail.phone}`} dir="ltr">
                          {detail.phone}
                        </a>
                      ) : (
                        'Not given'
                      )}
                    </dd>
                  </dl>
                  <button type="button" onClick={() => setDetail(withoutContact(detail))}>
                    Hide
                  </button>
                </>
              ) : (
                <>
                  <p className="admin-sub" id={revealHintId}>
                    This is recorded against your account.
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    aria-describedby={revealHintId}
                    onClick={() => void reveal()}
                  >
                    Reveal contact details
                  </button>
                </>
              )}
            </section>
          )}

          <section className="card" aria-labelledby={`${statusId}-cv`}>
            <h3 className="card-title" id={`${statusId}-cv`}>
              CV
            </h3>
            {detail.has_cv && !canSeePii ? (
              <p className="admin-sub">A CV is attached.</p>
            ) : detail.has_cv ? (
              <div className="app-drawer__cv">
                {/* A plain link: the server answers with an attachment, audited and rate-limited. */}
                <a className="btn" href={`/api/admin/applications/${detail.id}/cv`} download>
                  Download CV
                </a>
                <span className="admin-sub">{formatBytes(detail.cv_bytes)}</span>
                <Badge tone="warn">Not virus-scanned</Badge>
                <p className="admin-sub">Recorded against your account.</p>
              </div>
            ) : (
              <p className="admin-sub">No CV attached.</p>
            )}
          </section>

          <section className="card" aria-labelledby={`${statusId}-status`}>
            <h3 className="card-title" id={`${statusId}-status`}>
              Status
            </h3>
            <div className="field">
              <label htmlFor={statusId}>Status</label>
              <select
                id={statusId}
                value={detail.status}
                disabled={busy}
                onChange={(event) => void changeStatus(event.target.value)}
              >
                {APPLICATION_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {APPLICATION_STATUS_LABEL[value]}
                  </option>
                ))}
              </select>
            </div>
          </section>

          <section className="card" aria-labelledby={`${statusId}-notes`}>
            <h3 className="card-title" id={`${statusId}-notes`}>
              Internal notes
            </h3>
            <div className="field">
              <label htmlFor={notesId}>Notes for the team</label>
              <textarea
                id={notesId}
                value={notes}
                maxLength={NOTES_MAX}
                dir="auto"
                aria-describedby={notesCountId}
                onChange={(event) => setNotes(event.target.value)}
              />
              <p className="admin-sub" id={notesCountId}>
                {`${notes.length} of ${NOTES_MAX} characters`}
              </p>
            </div>
            <button
              type="button"
              data-variant="primary"
              disabled={busy || !dirty}
              onClick={() => void saveNotes()}
            >
              Save notes
            </button>
          </section>

          <section className="card" aria-labelledby={`${statusId}-consent`}>
            <h3 className="card-title" id={`${statusId}-consent`}>
              Consent and retention
            </h3>
            <dl className="stat-rows">
              <div className="stat-row">
                <dt>Agreed</dt>
                <dd>
                  {formatDate(detail.consent_at, { year: 'always' })} (notice{' '}
                  {detail.consent_version})
                </dd>
              </div>
              {detail.future_roles_consent && (
                <div className="stat-row">
                  <dt>Future roles too</dt>
                  <dd>Yes</dd>
                </div>
              )}
              <div className="stat-row">
                <dt>Kept until</dt>
                <dd>{formatDate(detail.retention_delete_after, { year: 'always' })}</dd>
              </div>
            </dl>
            {detail.status !== 'spam' && (
              <p className="admin-sub">
                Marking it spam deletes it within {SPAM_RETENTION_DAYS} days.
              </p>
            )}
          </section>
        </div>
      )}
    </Drawer>
  );
}
