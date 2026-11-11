import { useId, useRef, useState, type FormEvent } from 'react';
import Note from '@/components/admin/kit/Note';
import { useClock } from '@/components/admin/kit/clock';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';
import { IMPORT_COLUMNS, LAWFUL_BASES, type ImportColumn } from '@schemas/crmImport';
import type { ImportBatch } from '@/lib/crm/importBatches';
import {
  addPiece,
  COLUMN_LABELS,
  EMPTY_TALLY,
  problemGroups,
  readImportFile,
  tallyLines,
  type FileReading,
  type ImportTally,
} from '@/lib/crm/importScreen';

// Import contacts from a CSV file (Admin v2 C15, crm.md §12): the template and the columns,
// the file (read here first, for what a person can fix before sending: its size, its
// headings, how many people), the lawful-basis statement to tick, then the import in pieces
// of at most 50 people with a progress bar and Stop, then the result in words, by row number.
// The import route parses every piece again and decides; this screen never shows what a cell
// holds, keeps the file in memory only while the page is open, and puts nothing in an address
// or in storage.

const API = '/api/admin/crm/contacts/import';

export interface ImportContactsProps {
  initialBatches: ImportBatch[];
  /** Profile id → display name, for "By" (the CRM's directory). */
  names: Readonly<Record<string, string>>;
  me: string;
  /** The server's now, so the first render and the hydrated one agree. */
  now: string;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; done: number; total: number }
  | { kind: 'finished'; stopped: boolean; error?: string };

const BASIS_WORDS: Readonly<Record<(typeof LAWFUL_BASES)[number], string>> = {
  consent: 'they agreed to hear from us',
  contract: 'we work with them, or are about to (a client, a supplier)',
  legitimate_interest: 'a business reason that does not outweigh their interests',
  legal_obligation: 'a law requires us to keep it',
};

const COLUMN_HELP: Readonly<Record<ImportColumn, string>> = {
  name: 'Required.',
  email: 'An e-mail or a phone is required for each person.',
  phone: 'With the country code, or local to the country column.',
  company: 'Optional.',
  title: 'Optional.',
  city: 'Optional.',
  country: 'Two letters, like SA. Optional.',
  language: 'en or ar. English if empty.',
  stage: 'lead, client, past or partner. Lead if empty.',
  tags: 'Up to 10, separated by ; or |.',
  lawful_basis: 'Required for each person: consent, contract, legitimate_interest or legal_obligation.',
};

const STALE_MS = 2 * 60 * 60 * 1000;

export function batchStatus(batch: ImportBatch, now: number): string {
  if (batch.status === 'done') return 'Done';
  if (batch.status === 'stopped') return 'Stopped';
  return now - Date.parse(batch.createdAt) > STALE_MS ? 'Stopped before the end' : 'In progress';
}

export default function ImportContacts({ initialBatches, names, me, now }: ImportContactsProps) {
  const id = useId();
  const clock = useClock();
  const [reading, setReading] = useState<FileReading | null>(null);
  const [attested, setAttested] = useState(false);
  const [attestError, setAttestError] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [tally, setTally] = useState<ImportTally>(EMPTY_TALLY);
  const [batches, setBatches] = useState<ImportBatch[]>(initialBatches);
  const stopRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const nowMs = Date.parse(now) || 0;

  async function choose(file: File | undefined) {
    setPhase({ kind: 'idle' });
    setTally(EMPTY_TALLY);
    if (!file) {
      setReading(null);
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setReading({ ok: false, message: 'The file is larger than 2 MB. Split it into smaller files.' });
      return;
    }
    setReading(readImportFile(await file.text(), file.size));
  }

  async function refreshBatches() {
    try {
      const answer = await adminFetch<{ batches: ImportBatch[] }>(API);
      setBatches(answer.batches);
    } catch {
      // The list is a convenience; the result above already says what happened.
    }
  }

  async function run(event: FormEvent) {
    event.preventDefault();
    if (!reading?.ok || phase.kind === 'running') return;
    if (!attested) {
      setAttestError(true);
      return;
    }
    setAttestError(false);
    stopRef.current = false;
    let current = EMPTY_TALLY;
    setTally(current);
    setPhase({ kind: 'running', done: 0, total: reading.people });

    let batchId: string;
    try {
      const opened = await adminFetch<{ batchId: string }>(API, {
        method: 'POST',
        body: { step: 'open', rows: reading.people, bytes: reading.bytes, attested: true },
      });
      batchId = opened.batchId;
    } catch (err) {
      setPhase({ kind: 'finished', stopped: true, error: importErrorWords(err) });
      return;
    }

    let error: string | undefined;
    for (const piece of reading.pieces) {
      if (stopRef.current) break;
      try {
        const answer = await adminFetch<unknown>(API, {
          method: 'POST',
          body: { step: 'rows', batchId, rowNumbers: piece.rowNumbers, csv: piece.csv },
        });
        current = addPiece(current, piece.rowNumbers.length, answer);
        setTally(current);
        setPhase({ kind: 'running', done: current.sent, total: reading.people });
      } catch (err) {
        error = importErrorWords(err);
        break;
      }
    }
    const stopped = stopRef.current || error !== undefined;
    try {
      await adminFetch(API, { method: 'POST', body: { step: 'finish', batchId, stopped } });
    } catch (err) {
      error ??= importErrorWords(err);
    }
    setPhase({ kind: 'finished', stopped, ...(error ? { error } : {}) });
    void refreshBatches();
  }

  const running = phase.kind === 'running';
  const groups = problemGroups(tally.problems);
  const notImported = tally.problems.length;

  return (
    <div className="imp">
      <section className="card" aria-labelledby={`${id}-cols`}>
        <h2 id={`${id}-cols`} className="card__t">
          1. Prepare the file
        </h2>
        <p className="card__sub">
          A CSV file (in your spreadsheet, save as “CSV UTF-8”), up to 2 MB and 5,000 people,
          with these headings in the first row. Other columns are left out.
        </p>
        <p>
          <a className="btn" href={`${API}/template`} download>
            Download the template
          </a>
        </p>
        <table className="data imp__cols">
          <caption className="visually-hidden">The columns an import reads</caption>
          <thead>
            <tr>
              <th scope="col">Heading</th>
              <th scope="col">What it takes</th>
            </tr>
          </thead>
          <tbody>
            {IMPORT_COLUMNS.map((column) => (
              <tr key={column}>
                <th scope="row">
                  <code>{column}</code>
                </th>
                <td>{COLUMN_HELP[column]}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3 className="imp__h3">The lawful basis</h3>
        <p className="admin-sub">
          The reason the law lets us keep each person’s details. Write one for every row:
        </p>
        <ul className="imp__list">
          {LAWFUL_BASES.map((basis) => (
            <li key={basis}>
              <code>{basis}</code>: {BASIS_WORDS[basis]}.
            </li>
          ))}
        </ul>
        <p className="admin-sub">
          None of these lets us send marketing. People already in Contacts (the same e-mail, or
          the same phone when there is no e-mail) are left as they are, so a file can be imported
          again after fixing its rows.
        </p>
      </section>

      <form className="card" aria-labelledby={`${id}-file`} onSubmit={(e) => void run(e)} noValidate>
        <h2 id={`${id}-file`} className="card__t">
          2. Import
        </h2>
        <label className="field" htmlFor={`${id}-input`}>
          <span>Choose a CSV file</span>
          <input
            ref={fileRef}
            id={`${id}-input`}
            type="file"
            accept=".csv,text/csv"
            disabled={running}
            aria-describedby={`${id}-reading`}
            onChange={(e) => void choose(e.target.files?.[0])}
          />
        </label>
        <div id={`${id}-reading`} aria-live="polite">
          {reading && !reading.ok && (
            <Note tone="err" role="alert">
              {reading.message}
            </Note>
          )}
          {reading?.ok && (
            <p className="imp__found">
              Found {reading.people.toLocaleString('en-US')}{' '}
              {reading.people === 1 ? 'person' : 'people'} in{' '}
              {reading.columns.map((c) => COLUMN_LABELS[c]).join(', ')}.
              {reading.ignored.length > 0 &&
                ` Column${reading.ignored.length === 1 ? '' : 's'} ${reading.ignored.join(', ')} will be left out.`}
            </p>
          )}
        </div>

        <div className="field-group">
          <label className="field-inline" htmlFor={`${id}-attest`}>
            <input
              id={`${id}-attest`}
              type="checkbox"
              checked={attested}
              disabled={running}
              aria-invalid={attestError || undefined}
              aria-describedby={attestError ? `${id}-attest-err` : undefined}
              onChange={(e) => {
                setAttested(e.target.checked);
                if (e.target.checked) setAttestError(false);
              }}
            />
            <span>
              I confirm we may hold each person’s details on the lawful basis in their row, and
              that they know, or will be told, how we use them.
            </span>
          </label>
          {attestError && (
            <p id={`${id}-attest-err`} className="msg" data-kind="error" role="alert">
              Tick the statement to import.
            </p>
          )}
        </div>

        <div className="imp__actions">
          <button type="submit" data-variant="primary" disabled={!reading?.ok || running}>
            {reading?.ok
              ? `Import ${reading.people.toLocaleString('en-US')} ${reading.people === 1 ? 'person' : 'people'}`
              : 'Import'}
          </button>
          {running && (
            <button type="button" onClick={() => (stopRef.current = true)}>
              Stop
            </button>
          )}
        </div>

        {phase.kind === 'running' && (
          <div className="imp__progress">
            <progress
              id={`${id}-prog`}
              max={phase.total}
              value={phase.done}
              aria-label="Import progress"
            />
            <p role="status">
              Read {phase.done.toLocaleString('en-US')} of {phase.total.toLocaleString('en-US')}{' '}
              rows.
            </p>
          </div>
        )}

        {phase.kind === 'finished' && (
          <div className="imp__result" aria-live="polite">
            {phase.error && (
              <Note tone="err" role="alert">
                {phase.error}
              </Note>
            )}
            <h3 className="imp__h3">
              {phase.stopped ? 'The import stopped before the end' : 'The import is done'}
            </h3>
            {tallyLines(tally).map((line) => (
              <p key={line}>{line}</p>
            ))}
            {notImported > 0 && (
              <>
                <p>
                  Not imported: {notImported.toLocaleString('en-US')}{' '}
                  {notImported === 1 ? 'row' : 'rows'}. Fix them in the file and import it again.
                </p>
                <ul className="imp__list">
                  {groups.map((g) => (
                    <li key={g.why}>
                      {g.count === 1 ? 'Row' : 'Rows'} {g.rows}: {g.why}.
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p>
              <a href="/admin/contacts">Open contacts</a>
            </p>
          </div>
        )}
      </form>

      <section className="card" aria-labelledby={`${id}-recent`}>
        <h2 id={`${id}-recent`} className="card__t">
          Recent imports
        </h2>
        {batches.length === 0 ? (
          <p className="admin-sub">No imports yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">By</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="imp__num">
                    Rows
                  </th>
                  <th scope="col" className="imp__num">
                    Added
                  </th>
                  <th scope="col" className="imp__num">
                    Already contacts
                  </th>
                  <th scope="col" className="imp__num">
                    Repeated
                  </th>
                  <th scope="col" className="imp__num">
                    Not imported
                  </th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => (
                  <tr key={batch.id}>
                    <td>
                      <time dateTime={batch.createdAt}>{clock.formatDateTime(batch.createdAt)}</time>
                    </td>
                    <td dir="auto">
                      {batch.createdBy === me
                        ? 'You'
                        : batch.createdBy
                          ? (names[batch.createdBy] ?? 'A colleague')
                          : 'A former colleague'}
                    </td>
                    <td>{batchStatus(batch, nowMs)}</td>
                    <td className="imp__num">{batch.rows.toLocaleString('en-US')}</td>
                    <td className="imp__num">{batch.created.toLocaleString('en-US')}</td>
                    <td className="imp__num">{batch.duplicates.toLocaleString('en-US')}</td>
                    <td className="imp__num">{batch.repeats.toLocaleString('en-US')}</td>
                    <td className="imp__num">{batch.failed.toLocaleString('en-US')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/** A refusal in words: the route's own words when it gave some, else the kernel's. */
export function importErrorWords(err: unknown): string {
  if (err instanceof AdminApiError) {
    if (err.info.status === 429) {
      return 'You have reached the hourly limit for imports. Try again later.';
    }
    if (err.info.status === 404) {
      return 'This import has closed (they stay open for two hours). Import the file again: people already added are left as they are.';
    }
    if (err.info.detail) return err.info.detail;
  }
  return describeError(err);
}
