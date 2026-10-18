import { useEffect, useId, useRef, useState } from 'react';
import Drawer from '@/components/admin/kit/Drawer';
import Icon from '@/components/admin/kit/Icon';
import EditorForm from '@/components/admin/fields/EditorForm';
import { fileFacts } from '@/components/admin/fields/media/fileFacts';
import {
  caption,
  dimsText,
  sizeText,
  typeText,
  type MediaRow,
} from '@/components/admin/fields/media/format';
import { CONFLICT_TEXT, refusalText } from '@/components/admin/fields/media/refusalText';
import {
  displayNameOf,
  replaceImage,
  UploadAborted,
} from '@/components/admin/fields/media/xhrUpload';
import { adminFetch, describeError } from '@/lib/admin/client';
import { confirmDialog } from '@/lib/admin/confirm';
import { formatDateTime } from '@/lib/admin/relTime';
import { toast } from '@/lib/admin/toast';
import type { FieldDef } from '@/lib/admin/uiSchema';
import { useEntitySave } from '@/lib/admin/useEntitySave';
import type { MediaPermissions } from './libraryState';
import { inUseText, usageEntries, type UsageRow } from './usage';

// A picture's drawer (Admin v2 U4, the prototype's mediaDetail): the preview, the facts, the
// words (alt text in both languages, tags, folder), where it is used, and what the role may
// do with the file.
//
//   Save        every role that opens the library (full or meta): through the meta door,
//               PATCH /api/admin/media/meta/<id> (update_media_meta: version-checked,
//               audited as media_asset.update_meta, the upload's rules, D5/D6). Immediate
//               (P-3): no draft, no release.
//   Download    an uploaded picture's stored file (the route answers an attachment).
//   Replace     media.write at full, and a Worker that can take a file: the new file's
//               bytes checked here first, then sent with the version the form holds and
//               "Remove the old file from the web now" (removePrevious).
//   Delete      media.hardDelete (Admin), and only once "Used in" has loaded empty: while
//               it loads or fails the button stays off (fail closed); the route refuses a
//               picture in use either way.

export interface MediaDrawerProps {
  /** The picture as the list (or the page) read it. */
  row: MediaRow;
  open: boolean;
  permissions: MediaPermissions;
  /** Replace may be offered: media.write at full and uploads set up. */
  canReplace: boolean;
  onClose: () => void;
  /** Something about the picture changed: the list reads its page again. */
  onChanged: () => void;
  /** The picture is gone. */
  onDeleted: (id: string) => void;
}

/** The drawer's words, saved through the meta door. Module-level: the save hook keys on it. */
export const MEDIA_META_FIELDS: readonly FieldDef[] = [
  {
    name: 'alt',
    label: 'Alt text',
    kind: 'bilingual',
    required: true,
    maxLength: 300,
    help: 'What the picture shows, in a sentence. Screen readers read it aloud, and search engines index it.',
  },
  { name: 'tags', label: 'Tags', kind: 'tags', maxItems: 20, chips: { maxLength: 40 } },
  { name: 'folder', label: 'Folder', kind: 'text', maxLength: 200 },
];

type ReplaceStep =
  | { step: 'idle' }
  | { step: 'checking' }
  | { step: 'confirm'; file: File; facts: string }
  | { step: 'sending'; file: File; progress: number }
  | { step: 'refused'; message: string; conflict: boolean };

export default function MediaDrawer({
  row: listed,
  open,
  permissions,
  canReplace,
  onClose,
  onChanged,
  onDeleted,
}: MediaDrawerProps) {
  const id = String(listed['id']);
  const [row, setRow] = useState<MediaRow>(listed);
  const [usage, setUsage] = useState<UsageRow[] | null>(null);
  const [usageError, setUsageError] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [replace, setReplace] = useState<ReplaceStep>({ step: 'idle' });
  const [removePrevious, setRemovePrevious] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef<AbortController | null>(null);
  const reasonId = useId();
  const removeId = useId();

  const save = useEntitySave(
    { kind: 'resource', slug: 'media', saveUrl: (target) => `/api/admin/media/meta/${target}` },
    id,
    { fields: MEDIA_META_FIELDS },
  );

  useEffect(() => setRow(listed), [listed]);

  // A save landed: the tile's badge and caption may have changed.
  const savedAt = save.savedAt;
  useEffect(() => {
    if (savedAt) onChanged();
  }, [savedAt]);

  // Where it is used, read when the drawer opens.
  useEffect(() => {
    const controller = new AbortController();
    setUsage(null);
    setUsageError('');
    adminFetch<{ usage: UsageRow[] }>(`/api/admin/media/${id}/usage`, {
      signal: controller.signal,
    })
      .then((answer) => setUsage(answer.usage))
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setUsageError(describeError(err));
      });
    return () => controller.abort();
  }, [id]);

  // Stop a replace in flight when the drawer goes.
  useEffect(() => () => inFlight.current?.abort(), []);

  const mayDelete = permissions.hardDelete;
  const isUpload = row['provider'] === 'storage';
  const deleteReason =
    usageError !== ''
      ? 'We could not check where this picture is used, so it cannot be deleted now.'
      : usage === null
        ? 'Checking where this picture is used…'
        : inUseText(usage);

  async function remove() {
    setDeleteError('');
    const sure = await confirmDialog({
      message: 'Delete this picture? It cannot be undone.',
      confirmLabel: 'Delete',
    });
    if (!sure) return;
    try {
      const answer = await adminFetch<{ fileKept?: string }>(`/api/admin/media/${id}`, {
        method: 'DELETE',
      });
      toast(
        answer.fileKept
          ? 'Deleted. The file itself will be removed by the daily clean-up.'
          : 'Deleted.',
        'ok',
      );
      onDeleted(id);
    } catch (err) {
      setDeleteError(describeError(err));
    }
  }

  async function pickReplacement(file: File) {
    setReplace({ step: 'checking' });
    const facts = await fileFacts(file);
    if (!facts.ok) {
      setReplace({ step: 'refused', message: facts.detail, conflict: false });
      return;
    }
    const words = [file.name, sizeText(file.size), dimsText(facts.width, facts.height)]
      .filter(Boolean)
      .join(', ');
    setReplace({ step: 'confirm', file, facts: words });
  }

  async function sendReplacement(file: File) {
    const controller = new AbortController();
    inFlight.current = controller;
    setReplace({ step: 'sending', file, progress: 0 });
    const displayName = displayNameOf(file.name);
    try {
      const result = await replaceImage(
        id,
        file,
        {
          version: save.version,
          ...(displayName ? { displayName } : {}),
          ...(removePrevious ? { removePrevious: true } : {}),
        },
        {
          signal: controller.signal,
          onProgress: (progress) => setReplace({ step: 'sending', file, progress }),
        },
      );
      if (result.ok) {
        setRow(result.row);
        setReplace({ step: 'idle' });
        setRemovePrevious(false);
        toast('Picture replaced.', 'ok');
        await save.reloadTheirs();
        onChanged();
        return;
      }
      setReplace({
        step: 'refused',
        message:
          result.refusal.status === 409 ? CONFLICT_TEXT : refusalText(result.refusal, 'replace'),
        conflict: result.refusal.status === 409,
      });
    } catch (err) {
      setReplace(
        err instanceof UploadAborted
          ? { step: 'idle' }
          : { step: 'refused', message: describeError(err), conflict: false },
      );
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
    }
  }

  const preview = typeof row['preview_url'] === 'string' ? row['preview_url'] : null;
  const width = Number(row['width']) > 0 ? Number(row['width']) : 640;
  const height = Number(row['height']) > 0 ? Number(row['height']) : 480;
  const facts: [string, string][] = [
    ['File', caption(row)],
    ['Type', typeText(row)],
    ['Dimensions', dimsText(row['width'], row['height']) ?? 'Not recorded'],
    ['Size', sizeText(row['size_bytes']) ?? 'Not recorded'],
    ['Added', row['created_at'] ? formatDateTime(String(row['created_at'])) : 'Not recorded'],
    ['Folder', typeof row['folder'] === 'string' && row['folder'] ? row['folder'] : 'None'],
  ];
  const entries = usage ? usageEntries(permissions.opens, usage) : [];
  const busy = replace.step === 'sending' || replace.step === 'checking';

  return (
    <Drawer
      open={open}
      onClose={() => {
        inFlight.current?.abort();
        onClose();
      }}
      title={caption(row)}
      footer={
        <div className="md__acts">
          {mayDelete && (
            <span className="md__del">
              <button
                type="button"
                className="btn"
                data-variant="danger"
                disabled={deleteReason !== null || busy}
                aria-describedby={deleteReason ? reasonId : undefined}
                onClick={() => void remove()}
              >
                <Icon name="trash" size={14} />
                Delete
              </button>
              {deleteReason && (
                <span id={reasonId} className="md__reason">
                  {deleteReason}
                </span>
              )}
            </span>
          )}
          {isUpload && (
            <a className="btn" href={`/api/admin/media/${id}/download`} download>
              <Icon name="download" size={14} />
              Download
            </a>
          )}
          {canReplace && (
            <button
              type="button"
              data-variant="primary"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              <Icon name="upload" size={14} />
              Replace file
            </button>
          )}
        </div>
      }
    >
      <div className="md">
        <div className="md__pv">
          {preview ? (
            <img src={preview} alt="" width={width} height={height} decoding="async" />
          ) : (
            <Icon name="image" size={32} />
          )}
        </div>

        {replace.step === 'checking' && <p className="admin-sub">Checking the file…</p>}
        {replace.step === 'confirm' && (
          <div className="md__replace" role="group" aria-label="Replace this picture">
            <p>
              <strong>Replace this picture everywhere it is used?</strong>
            </p>
            <p className="admin-sub" dir="auto">
              {replace.facts}
            </p>
            <label className="md__check" htmlFor={removeId}>
              <input
                id={removeId}
                type="checkbox"
                checked={removePrevious}
                onChange={(e) => setRemovePrevious(e.target.checked)}
              />
              Remove the old file from the web now
            </label>
            <div className="toolbar">
              <button
                type="button"
                data-variant="primary"
                onClick={() => void sendReplacement(replace.file)}
              >
                Replace
              </button>
              <button type="button" className="btn" onClick={() => setReplace({ step: 'idle' })}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {replace.step === 'sending' && (
          <div className="upl__p">
            <progress
              max={100}
              value={Math.round(replace.progress * 100)}
              aria-label={`Replacing with ${replace.file.name}`}
            />
            <span aria-hidden="true">{`${Math.round(replace.progress * 100)}%`}</span>
          </div>
        )}
        {replace.step === 'refused' && (
          <div className="msg" data-kind="error" role="alert">
            <span>{replace.message}</span>
            {replace.conflict && (
              <button
                type="button"
                onClick={() => {
                  setReplace({ step: 'idle' });
                  void save.reloadTheirs();
                }}
              >
                Reload their version
              </button>
            )}
          </div>
        )}
        {deleteError && (
          <p className="msg" data-kind="error" role="alert">
            {deleteError}
          </p>
        )}

        <dl className="md__facts">
          {facts.map(([term, value]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd dir="auto">{value}</dd>
            </div>
          ))}
        </dl>

        <EditorForm save={save} fields={MEDIA_META_FIELDS} submitLabel="Save changes" />

        <section className="md__used" aria-labelledby={`${reasonId}-used`}>
          <h3 id={`${reasonId}-used`}>Used in</h3>
          {usageError ? (
            <p className="msg" data-kind="error">
              {usageError}
            </p>
          ) : usage === null ? (
            <p className="admin-sub">Loading…</p>
          ) : entries.length === 0 ? (
            <p className="admin-sub">Not used anywhere yet.</p>
          ) : (
            <ul className="md__pills">
              {entries.map((entry) => (
                <li key={entry.key}>
                  {entry.href ? (
                    <a className="chip" href={entry.href} dir="auto">
                      {entry.words}
                    </a>
                  ) : (
                    <span className="chip" dir="auto">
                      {entry.words}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {canReplace && (
          <input
            ref={fileInput}
            type="file"
            className="visually-hidden"
            tabIndex={-1}
            aria-hidden="true"
            accept="image/jpeg,image/png,image/webp"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void pickReplacement(file);
            }}
          />
        )}
      </div>
    </Drawer>
  );
}
