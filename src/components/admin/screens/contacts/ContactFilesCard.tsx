import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useClock } from '@/components/admin/kit/clock';
import { Badge } from '@/components/admin/kit/StatusBadge';
import { AdminApiError, adminFetch, adminUpload, describeError } from '@/lib/admin/client';
import { confirmDialog } from '@/lib/admin/confirm';
import { isoOf } from '@/lib/admin/relTime';
import { FORMER_MEMBER } from '@/lib/crm/leadView';
import { CRM_FILE_ACCEPT, CRM_FILES_PER_CONTACT } from '@schemas/crmFiles';
import {
  defaultFileName,
  fileKindLabel,
  fileProblem,
  fileSize,
  type FileItem,
} from '@/lib/crm/fileView';

// A contact's files (Admin v2 C16, crm.md §12). Drawn on a contact's page for `crm.files`
// holders only (a UX hint: every route checks `crm.files`, a live recheck, and the database
// again), loaded with import() once the page is up, so the page's first load does not carry it.
//
// The list comes from GET …/files (names, kinds, sizes, when and who; never where a file is
// kept). Download is a plain link: the server answers with an attachment, after a live
// recheck, a limit and an audit row written first. Remove asks first and takes the file out of
// storage before its record. Add sends the file and its name (multipart, the CSRF header); the
// server decides what the file is by its bytes. None of this is virus-scanned, and the card
// says so beside every download.

export interface ContactFilesCardProps {
  contactId: string;
  /** Who added a file, by id (the page's people directory). */
  people: ReadonlyMap<string, string>;
  /** After a file is added (the contact's activity) or removed. */
  onChanged: () => void;
}

export default function ContactFilesCard({ contactId, people, onChanged }: ContactFilesCardProps) {
  const { formatDate } = useClock();
  const id = useId();
  const base = `/api/admin/crm/contacts/${contactId}/files`;
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<FileItem[] | null>(null);
  const [unavailable, setUnavailable] = useState('');
  const [chosen, setChosen] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<{ field: 'file' | 'name'; message: string } | null>(null);
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    adminFetch<{ files: FileItem[] }>(base, { signal: controller.signal })
      .then((answer) => setFiles(answer.files))
      .catch(() => {
        if (!controller.signal.aborted) setUnavailable('Files are unavailable right now.');
      });
    return () => controller.abort();
  }, [base]);

  function choose(file: File | null) {
    setChosen(file);
    setError(null);
    setSaid('');
    if (file) setName(defaultFileName(file.name));
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    const problem = fileProblem(chosen, name);
    if (problem || !chosen) {
      setError(problem ?? { field: 'file', message: 'Choose a file first.' });
      return;
    }
    setBusy(true);
    setError(null);
    setSaid('');
    try {
      const form = new FormData();
      form.set('file', chosen);
      form.set('name', name.trim());
      const answer = await adminUpload<{ file: FileItem }>(base, form);
      setFiles((list) => [answer.file, ...(list ?? [])]);
      setChosen(null);
      setName('');
      if (input.current) input.current.value = '';
      setSaid('File added.');
      onChanged();
    } catch (err) {
      const field =
        err instanceof AdminApiError && err.info.field === 'name' ? ('name' as const) : 'file';
      setError({
        field,
        message:
          err instanceof AdminApiError && err.info.status === 429
            ? 'You have added a lot of files today. Try again tomorrow.'
            : describeError(err),
      });
    } finally {
      setBusy(false);
    }
  }

  async function remove(file: FileItem) {
    const sure = await confirmDialog({
      message: `Remove ${file.name}? It cannot be brought back.`,
      confirmLabel: 'Remove file',
    });
    if (!sure) return;
    setBusy(true);
    setError(null);
    setSaid('');
    try {
      await adminFetch(`${base}/${file.id}`, { method: 'DELETE' });
      setFiles((list) => (list ?? []).filter((f) => f.id !== file.id));
      setSaid('File removed.');
      onChanged();
    } catch (err) {
      setError({ field: 'file', message: describeError(err) });
    } finally {
      setBusy(false);
    }
  }

  const full = files !== null && files.length >= CRM_FILES_PER_CONTACT;
  const fileError = error?.field === 'file' ? error.message : '';
  const nameError = error?.field === 'name' ? error.message : '';

  return (
    <section className="card" aria-labelledby={`${id}-h`}>
      <div className="card__h">
        <div>
          <h2 id={`${id}-h`} className="card__t">
            Files
          </h2>
          <p className="card__sub">Files are not virus-scanned. Open them in an up-to-date app.</p>
        </div>
      </div>
      {unavailable ? (
        <p className="msg" data-kind="error" role="alert">
          {unavailable}
        </p>
      ) : files === null ? (
        <p className="f__hint">Loading the files…</p>
      ) : files.length === 0 ? (
        <p className="f__hint">No files yet.</p>
      ) : (
        <ol className="lead-notes" aria-label="Files, newest first">
          {files.map((file) => (
            <li key={file.id} className="lead-notes__i">
              <p className="lead-notes__b" dir="auto">
                {file.name}
              </p>
              <p className="lead-notes__m">
                <span>
                  {fileKindLabel(file.content_type)}, {fileSize(file.bytes)}
                </span>
                <span dir="auto">
                  {file.created_by ? (people.get(file.created_by) ?? FORMER_MEMBER) : FORMER_MEMBER}
                </span>
                <time dateTime={isoOf(file.created_at)}>{formatDate(file.created_at)}</time>
              </p>
              <p className="lead-notes__m">
                {/* A plain link: the server answers with an attachment, audited and rate-limited. */}
                <a className="btn" data-size="sm" href={`${base}/${file.id}`} download>
                  Download<span className="visually-hidden"> {file.name}</span>
                </a>
                <Badge tone="warn">Not virus-scanned</Badge>
                <button
                  type="button"
                  data-size="sm"
                  data-variant="ghost"
                  disabled={busy}
                  onClick={() => void remove(file)}
                >
                  Remove<span className="visually-hidden"> {file.name}</span>
                </button>
              </p>
            </li>
          ))}
        </ol>
      )}
      {!unavailable && files !== null && full ? (
        <p className="f__hint">
          A contact keeps up to {CRM_FILES_PER_CONTACT} files. Remove one to add another.
        </p>
      ) : null}
      {!unavailable && files !== null && !full ? (
        <form onSubmit={(event) => void add(event)} noValidate>
          <div className="f">
            <label className="f__l" htmlFor={`${id}-file`}>
              Add a file
            </label>
            <input
              ref={input}
              id={`${id}-file`}
              type="file"
              accept={CRM_FILE_ACCEPT}
              aria-invalid={fileError ? true : undefined}
              aria-describedby={`${id}-file-hint${fileError ? ` ${id}-file-error` : ''}`}
              onChange={(event) => choose(event.target.files?.[0] ?? null)}
            />
            <p id={`${id}-file-hint`} className="f__hint">
              A PDF, a Word document or an image, up to 10 MB. Keep only what you need to work with
              them: no ID cards, passports or health records.
            </p>
            {fileError ? (
              <p id={`${id}-file-error`} className="field-error f__err">
                {fileError}
              </p>
            ) : null}
          </div>
          {chosen ? (
            <div className="f">
              <label className="f__l" htmlFor={`${id}-name`}>
                Name
              </label>
              <input
                id={`${id}-name`}
                maxLength={120}
                dir="auto"
                autoComplete="off"
                value={name}
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? `${id}-name-error` : undefined}
                onChange={(event) => setName(event.target.value)}
              />
              {nameError ? (
                <p id={`${id}-name-error`} className="field-error f__err">
                  {nameError}
                </p>
              ) : null}
            </div>
          ) : null}
          <button type="submit" data-size="sm" disabled={busy}>
            Add file
          </button>
        </form>
      ) : null}
      <p className="visually-hidden" role="status">
        {said}
      </p>
    </section>
  );
}
