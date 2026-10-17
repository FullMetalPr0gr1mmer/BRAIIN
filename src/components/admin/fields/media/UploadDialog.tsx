import { useEffect, useReducer, useRef, useState } from 'react';
import ErrorSummary, { type FieldError } from '@/components/admin/kit/ErrorSummary';
import Modal from '@/components/admin/kit/Modal';
import { toast } from '@/lib/admin/toast';
import ChipsField from '../ChipsField';
import FieldShell from '../FieldShell';
import BodyPortal from './BodyPortal';
import { fileFacts } from './fileFacts';
import { dimsText, sizeText, type MediaRow } from './format';
import { refusalText } from './refusalText';
import { altProblem, nextToSend, queueReducer, queueSummary, type UploadItem } from './uploadQueue';
import { displayNameOf, uploadImage, UploadAborted } from './xhrUpload';

// "Describe your images" (Admin v2 U4, ui.md "Media library", the mockup deviation: alt text
// in both languages is required before anything is sent). One row per chosen file: its name,
// size and decoded size, or why it will be refused (fileFacts: the server's own words), then
// Alt (English), Alt (Arabic) and Tags. "Upload N pictures" sends the described files one at
// a time (uploadQueue), each with its own progress bar, then says "Uploaded" or the server's
// words with "Try again". Cancel stops the file in flight and keeps nothing pending. Leaving
// the page while a file is sending asks first.
//
// No preview of the picture: img-src has no blob: (CSP), so none is made; the name, the size
// and the decoded dimensions say which file a row is.

export interface UploadDialogProps {
  /** The files to describe; a new array opens a new batch. Empty: the dialog is closed. */
  files: readonly File[];
  onClose: () => void;
  /** Every picture this batch stored, once nothing is left sending. */
  onUploaded: (rows: MediaRow[]) => void;
  /** The picker's single upload: one file, and the dialog closes on success. */
  single?: boolean;
}

let nextKey = 1;

export function picturesText(n: number): string {
  return n === 1 ? '1 picture' : `${n.toLocaleString('en-GB')} pictures`;
}

export default function UploadDialog({ files, onClose, onUploaded, single }: UploadDialogProps) {
  const [items, dispatch] = useReducer(queueReducer, []);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const blobs = useRef(new Map<number, File>());
  const inFlight = useRef<AbortController | null>(null);
  const batch = useRef<MediaRow[]>([]);
  // Moves when a send settles, so the runner below looks for the next file even when the
  // queue's next item is the same object it was (nothing else re-runs the effect then).
  const [settled, setSettled] = useState(0);
  // Whether the dialog is up. It closes itself (shown false: the native dialog closes and
  // focus goes back to what opened it), and only then tells the parent (onClose), which drops
  // the files; unmounting a dialog that is still open would drop focus to <body>.
  const [shown, setShown] = useState(false);

  // A new set of files is a new batch.
  useEffect(() => {
    if (files.length === 0) return;
    const chosen = (single ? files.slice(0, 1) : files).map((file) => ({
      key: nextKey++,
      file,
    }));
    dispatch({ type: 'clear' });
    blobs.current = new Map(chosen.map(({ key, file }) => [key, file]));
    batch.current = [];
    setErrors([]);
    dispatch({
      type: 'add',
      files: chosen.map(({ key, file }) => ({ key, name: file.name, size: file.size })),
    });
    for (const { key, file } of chosen) {
      void fileFacts(file).then((facts) => dispatch({ type: 'checked', key, facts }));
    }
    setShown(true);
  }, [files, single]);

  // One file at a time: when none is in flight, send the next queued one.
  const next = nextToSend(items);
  useEffect(() => {
    if (!next || inFlight.current) return;
    const file = blobs.current.get(next.key);
    if (!file) return;
    const controller = new AbortController();
    inFlight.current = controller;
    dispatch({ type: 'sending', key: next.key });
    const tags = next.tags.map((t) => t.trim()).filter(Boolean);
    const displayName = displayNameOf(file.name);
    uploadImage(
      file,
      {
        alt: { en: next.alt.en.trim(), ar: next.alt.ar.trim() },
        ...(displayName ? { displayName } : {}),
        ...(tags.length > 0 ? { tags } : {}),
      },
      {
        signal: controller.signal,
        onProgress: (fraction) => dispatch({ type: 'progress', key: next.key, fraction }),
      },
    )
      .then((result) => {
        if (result.ok) {
          batch.current.push(result.row);
          dispatch({ type: 'done', key: next.key, row: result.row });
        } else {
          const detail = refusalText(result.refusal);
          dispatch({
            type: result.refusal.status === 0 ? 'failed' : 'refused',
            key: next.key,
            detail,
          });
        }
      })
      .catch((err: unknown) => {
        // Cancel already put the file back to ready; any other throw is a failure to show.
        if (!(err instanceof UploadAborted)) {
          dispatch({
            type: 'failed',
            key: next.key,
            detail: refusalText({ status: 0, error: '' }),
          });
        }
      })
      .finally(() => {
        if (inFlight.current === controller) inFlight.current = null;
        setSettled((n) => n + 1);
      });
  }, [next, settled]);

  const summary = queueSummary(items);

  // The batch ended: say so, hand over what was stored, close unless something needs a look.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (summary.busy) {
      wasBusy.current = true;
      return;
    }
    if (!wasBusy.current) return;
    wasBusy.current = false;
    const stored = batch.current;
    batch.current = [];
    if (stored.length > 0) {
      toast(`${picturesText(stored.length)} uploaded`, 'ok');
      onUploaded(stored);
    }
    if (summary.problems === 0 && summary.sendable === 0) setShown(false);
  }, [summary.busy, summary.problems, summary.sendable, onUploaded]);

  // Leaving while a file is on its way asks first.
  useEffect(() => {
    if (!summary.busy) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [summary.busy]);

  function submit() {
    const missing: FieldError[] = [];
    for (const item of items) {
      if (item.state !== 'ready') continue;
      for (const lang of ['en', 'ar'] as const) {
        const problem = altProblem(item.alt[lang]);
        if (problem) {
          missing.push({
            id: `upl-${item.key}-alt-${lang}`,
            message: `${item.name}: Alt text (${lang === 'en' ? 'English' : 'Arabic'}) ${problem}`,
          });
        }
      }
    }
    setErrors(missing);
    if (missing.length === 0) dispatch({ type: 'submit' });
  }

  /** Stops the file in flight and puts every queued one back: nothing stays pending. */
  function stop() {
    inFlight.current?.abort();
    inFlight.current = null;
    dispatch({ type: 'cancel' });
  }

  /** Cancel (or Stop uploading): stops a batch in flight, else closes the dialog. */
  function cancel() {
    if (summary.busy) {
      stop();
      return;
    }
    setShown(false);
  }

  /** The dialog closed, however (Escape, Close, Cancel, the batch done): nothing is left sending. */
  function closed() {
    if (inFlight.current || summary.busy) stop();
    setShown(false);
    onClose();
  }

  const sendable = items.filter((i) => i.state === 'ready').length;
  const uploadLabel =
    single || sendable <= 1 ? 'Upload picture' : `Upload ${picturesText(sendable)}`;

  if (files.length === 0) return null;
  return (
    <BodyPortal>
      <Modal
        open={shown}
        onClose={closed}
        title="Describe your images"
        sub="Alt text in English and Arabic is required for every picture."
        size="lg"
        dismissible={false}
        footer={
          <>
            <button type="button" className="btn" onClick={cancel}>
              {summary.busy ? 'Stop uploading' : 'Cancel'}
            </button>
            <button
              type="button"
              data-variant="primary"
              disabled={summary.busy || summary.checking || sendable === 0}
              onClick={submit}
            >
              {uploadLabel}
            </button>
          </>
        }
      >
        <ErrorSummary errors={errors} title="Describe every picture before it is sent" />
        <ol className="upl">
          {items.map((item) => (
            <UploadRow
              key={item.key}
              item={item}
              errors={errors}
              onAlt={(lang, value) =>
                dispatch({ type: 'edit', key: item.key, alt: { [lang]: value } })
              }
              onTags={(tags) => dispatch({ type: 'edit', key: item.key, tags })}
              onRetry={() => dispatch({ type: 'retry', key: item.key })}
            />
          ))}
        </ol>
      </Modal>
    </BodyPortal>
  );
}

interface UploadRowProps {
  item: UploadItem;
  errors: readonly FieldError[];
  onAlt: (lang: 'en' | 'ar', value: string) => void;
  onTags: (tags: string[]) => void;
  onRetry: () => void;
}

function UploadRow({ item, errors, onAlt, onTags, onRetry }: UploadRowProps) {
  const prefix = `upl-${item.key}`;
  const errorOf = (id: string) => errors.find((e) => e.id === id)?.message;
  const facts = [sizeText(item.size), dimsText(item.width, item.height)].filter(Boolean).join(', ');
  const locked = item.state === 'sending' || item.state === 'queued' || item.state === 'done';
  const pct = Math.round(item.progress * 100);
  return (
    <li className="upl__i" data-state={item.state}>
      <div className="upl__h">
        <span className="upl__n" dir="auto">
          {item.name}
        </span>
        <span className="upl__f">{facts}</span>
      </div>
      {item.state === 'checking' && <p className="admin-sub">Checking the file…</p>}
      {item.state === 'refused-locally' && (
        <p className="msg" data-kind="error">
          {item.detail} This file will not be sent.
        </p>
      )}
      {item.state !== 'checking' && item.state !== 'refused-locally' && (
        <fieldset className="upl__b" disabled={locked}>
          <legend className="visually-hidden">Describe {item.name}</legend>
          <FieldShell
            id={`${prefix}-alt-en`}
            label="Alt text (English)"
            required
            error={errorOf(`${prefix}-alt-en`)}
          >
            <input
              id={`${prefix}-alt-en`}
              type="text"
              lang="en"
              maxLength={300}
              required
              aria-invalid={errorOf(`${prefix}-alt-en`) ? true : undefined}
              aria-describedby={errorOf(`${prefix}-alt-en`) ? `${prefix}-alt-en-error` : undefined}
              value={item.alt.en}
              onChange={(e) => onAlt('en', e.target.value)}
            />
          </FieldShell>
          <FieldShell
            id={`${prefix}-alt-ar`}
            label="Alt text (Arabic)"
            required
            error={errorOf(`${prefix}-alt-ar`)}
          >
            <input
              id={`${prefix}-alt-ar`}
              type="text"
              lang="ar"
              dir="rtl"
              maxLength={300}
              required
              aria-invalid={errorOf(`${prefix}-alt-ar`) ? true : undefined}
              aria-describedby={errorOf(`${prefix}-alt-ar`) ? `${prefix}-alt-ar-error` : undefined}
              value={item.alt.ar}
              onChange={(e) => onAlt('ar', e.target.value)}
            />
          </FieldShell>
          <ChipsField
            field={{
              name: 'tags',
              label: 'Tags',
              kind: 'tags',
              maxItems: 20,
              chips: { maxLength: 40 },
            }}
            value={item.tags}
            onChange={(_name, value) => onTags(Array.isArray(value) ? (value as string[]) : [])}
            idPrefix={prefix}
          />
        </fieldset>
      )}
      {(item.state === 'sending' || item.state === 'queued') && (
        <div className="upl__p">
          <progress
            id={`${prefix}-progress`}
            max={100}
            value={pct}
            aria-label={`Uploading ${item.name}`}
          />
          <span aria-hidden="true">{item.state === 'queued' ? 'Waiting' : `${pct}%`}</span>
        </div>
      )}
      {item.state === 'done' && (
        <p className="upl__ok" role="status">
          Uploaded
        </p>
      )}
      {(item.state === 'refused' || item.state === 'failed') && (
        <div className="upl__err">
          <p className="msg" data-kind="error" role="alert">
            {item.detail}
          </p>
          <button type="button" className="btn" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </li>
  );
}
