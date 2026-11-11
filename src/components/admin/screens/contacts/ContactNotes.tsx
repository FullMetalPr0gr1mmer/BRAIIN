import { useEffect, useId, useState, type FormEvent } from 'react';
import { useClock } from '@/components/admin/kit/clock';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';
import { confirmDialog } from '@/lib/admin/confirm';
import { isoOf } from '@/lib/admin/relTime';
import { FORMER_MEMBER } from '@/lib/crm/leadView';

// A contact's notes (Admin v2 C7, crm.md §11 screen 6: "Only your team sees notes."). Read when
// the page opens through GET /api/admin/crm/contacts/[id]/notes (`crm.contacts`, a live
// recheck, a limit of its own, and an audit row written before the notes are read: a refusal
// or a failed audit shows "Notes are unavailable right now"). A note is added with POST
// (append-only; its author is the session's person) and, for an Admin (`crm.erase`), deleted
// with DELETE after a confirm. The notes live in this component's state only.

interface NoteRow {
  id: string;
  body: string;
  created_at: string;
  author: { id: string; display_name: string | null } | null;
}

interface Props {
  contactId: string;
  me: { id: string; name: string };
  canDelete: boolean;
  /** After a note is added or deleted: the timeline is read again. */
  onChanged: () => void;
}

export default function ContactNotes({ contactId, me, canDelete, onChanged }: Props) {
  const { formatDateTime, relTime } = useClock();
  const id = useId();
  const [notes, setNotes] = useState<NoteRow[] | null>(null);
  const [more, setMore] = useState(false);
  const [unavailable, setUnavailable] = useState('');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const controller = new AbortController();
    adminFetch<{ notes: NoteRow[]; more: boolean }>(`/api/admin/crm/contacts/${contactId}/notes`, {
      signal: controller.signal,
    })
      .then((answer) => {
        setNotes(answer.notes);
        setMore(answer.more);
        setNow(Date.now());
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setUnavailable(
          err instanceof AdminApiError && err.info.status === 429
            ? 'You have opened a lot of notes in the last hour. Try again later.'
            : 'Notes are unavailable right now.',
        );
      });
    return () => controller.abort();
  }, [contactId]);

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
        `/api/admin/crm/contacts/${contactId}/notes`,
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
      await adminFetch(`/api/admin/crm/contacts/${contactId}/notes/${note.id}`, {
        method: 'DELETE',
      });
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
          <p className="card__sub">Only your team sees notes.</p>
        </div>
      </div>
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
      {unavailable ? (
        <p className="msg" data-kind="error" role="alert">
          {unavailable}
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
      {more && <p className="f__hint">Showing the newest 200 notes.</p>}
    </section>
  );
}
