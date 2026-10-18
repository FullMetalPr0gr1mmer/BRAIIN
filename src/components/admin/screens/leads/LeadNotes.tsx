import { useEffect, useId, useState, type FormEvent } from 'react';
import { adminFetch, describeError } from '@/lib/admin/client';
import { confirmDialog } from '@/lib/admin/confirm';
import { formatDateTime, isoOf, relTime } from '@/lib/admin/relTime';
import { FORMER_MEMBER } from '@/lib/crm/leadView';

// The notes thread (Admin v2 C4b, crm.md §11 screen 3): read when the page opens, for the
// roles that may see contact details, through GET /api/admin/leads/[id]/notes (`leads.pii`, a
// live recheck, and an audit row written before the thread is read: a refusal or a failed
// audit shows "Notes are unavailable right now"). A note is added with POST (append-only;
// its author is the session's person) and, for an Admin (`crm.erase`), deleted with DELETE
// after a confirm. The thread lives in this component's state only.

interface NoteRow {
  id: string;
  body: string;
  created_at: string;
  author: { id: string; display_name: string | null } | null;
}

interface Props {
  leadId: string;
  /** The signed-in person: the author of a note added here. */
  me: { id: string; name: string };
  canDelete: boolean;
  /** After a note is added or deleted: the timeline is read again. */
  onChanged: () => void;
}

export default function LeadNotes({ leadId, me, canDelete, onChanged }: Props) {
  const id = useId();
  const [notes, setNotes] = useState<NoteRow[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const controller = new AbortController();
    adminFetch<{ notes: NoteRow[] }>(`/api/admin/leads/${leadId}/notes`, {
      signal: controller.signal,
    })
      .then((answer) => {
        setNotes(answer.notes);
        setNow(Date.now());
      })
      .catch(() => {
        if (!controller.signal.aborted) setUnavailable(true);
      });
    return () => controller.abort();
  }, [leadId]);

  async function add(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body) {
      setError('Write something first.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const added = await adminFetch<{ id: string; created_at: string }>(
        `/api/admin/leads/${leadId}/notes`,
        { method: 'POST', body: { body } },
      );
      setNotes((list) => [
        { ...added, body, author: { id: me.id, display_name: me.name } },
        ...(list ?? []),
      ]);
      setDraft('');
      setNow(Date.now());
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(note: NoteRow) {
    const sure = await confirmDialog({
      message: 'Delete this note? The timeline keeps a line saying a note was deleted.',
      confirmLabel: 'Delete note',
    });
    if (!sure) return;
    setBusy(true);
    setError('');
    try {
      await adminFetch(`/api/admin/leads/${leadId}/notes/${note.id}`, { method: 'DELETE' });
      setNotes((list) => (list ?? []).filter((n) => n.id !== note.id));
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby={`${id}-h`}>
      <div className="card__h">
        <div>
          <h2 id={`${id}-h`} className="card__t">
            Notes
          </h2>
          <p className="card__sub">Only your team sees these.</p>
        </div>
      </div>
      {unavailable ? (
        <p className="msg" data-kind="error" role="alert">
          Notes are unavailable right now.
        </p>
      ) : notes === null ? (
        <p className="f__hint">Loading the notes…</p>
      ) : notes.length === 0 ? (
        <p className="f__hint">No notes yet.</p>
      ) : (
        <ol className="lead-notes" aria-label="Notes, newest first">
          {notes.map((note) => (
            <li key={note.id} className="lead-notes__i">
              <p className="lead-notes__b" dir="auto">
                {note.body}
              </p>
              <p className="lead-notes__m">
                <span dir="auto">
                  {note.author
                    ? note.author.display_name?.trim() || 'A member with no name'
                    : FORMER_MEMBER}
                </span>
                <time dateTime={isoOf(note.created_at)} title={formatDateTime(note.created_at)}>
                  {relTime(note.created_at, now)}
                </time>
                {canDelete && (
                  <button
                    type="button"
                    data-size="sm"
                    data-variant="ghost"
                    disabled={busy}
                    onClick={() => void remove(note)}
                  >
                    Delete note
                  </button>
                )}
              </p>
            </li>
          ))}
        </ol>
      )}
      {!unavailable && (
        <form onSubmit={(event) => void add(event)}>
          <div className="f">
            <label className="visually-hidden" htmlFor={`${id}-new`}>
              New note
            </label>
            <textarea
              id={`${id}-new`}
              rows={3}
              maxLength={5000}
              dir="auto"
              placeholder="Write a note…"
              value={draft}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={(event) => setDraft(event.target.value)}
            />
            {error && (
              <p id={`${id}-error`} className="field-error f__err">
                {error}
              </p>
            )}
          </div>
          <button type="submit" data-size="sm" disabled={busy}>
            Add note
          </button>
        </form>
      )}
    </section>
  );
}
