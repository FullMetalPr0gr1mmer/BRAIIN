import { useState } from 'react';
import PendingBadge, { pendingKindOf, type PendingKind } from '@/components/admin/kit/PendingBadge';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';
import { confirmDialog } from '@/lib/admin/confirm';
import { DRAFT_GONE_WORDS, type EditorDraft } from '@/lib/admin/entitySave';
import { announcePending } from '@/lib/admin/releaseEvents';
import { columnOf, type FieldDef } from '@/lib/admin/uiSchema';
import type { EntitySave } from '@/lib/admin/useEntitySave';

// An editor's head in release mode (Admin v2 R12; releases.md §7 "Per-item badges" and
// "Conflicts", §4.5, §4.8): the pending change the record carries, in words and a badge, and
// what can be done about it here:
//   - Discard changes (one change, `DELETE /api/admin/drafts/[id]?version=`; a confirm that
//     says the live site does not change); a new item's discard goes back to its list;
//   - Undo removal (the same discard, of a staged removal: nothing is lost, so no confirm);
//   - a conflict (R3's base rule: live moved since the change began): Keep my version, Use
//     the live version (`POST /api/admin/drafts/[id]/resolve`, per column) and Compare
//     (`GET /api/admin/drafts/[id]/compare`: live now and yours, as text);
//   - a change published or thrown away under the form, or scheduled: what happened and the
//     way on (the Save button reads "Save again" then).
// Nothing renders in live mode (releases off: no answer carries `draft`). Every action is the
// server's to allow (the draft endpoints check the type's capabilities and RLS again).

export interface DraftNoticeProps {
  save: EntitySave;
  fields: readonly FieldDef[];
  /** The record in words for the confirm: "service". */
  noun: string;
  /** Where a discarded new item goes back to (its list). */
  backHref?: string | undefined;
}

const LINES: Readonly<Record<PendingKind, string>> = {
  changed: 'Saved, not live yet: it goes live when it is published.',
  new: 'This new item is not on the site yet: it goes live when it is published.',
  removal: 'This item comes off the site when the removal is published.',
  scheduled: 'Scheduled to go live. It is locked until then.',
  conflict: 'Changed on the live site since this edit started.',
};

interface CompareRow {
  column: string;
  label: string;
  kind: 'text' | 'bilingual' | 'changed';
  live?: unknown;
  yours?: unknown;
}

/** One side of a compared value, as text: a bilingual pair as its two languages. */
function Side({ value, kind }: { value: unknown; kind: CompareRow['kind'] }) {
  if (kind === 'changed') return <em>changed</em>;
  if (kind === 'bilingual') {
    const pair = (value ?? {}) as Record<string, unknown>;
    return (
      <>
        <span className="cmp__en" dir="auto">
          {typeof pair['en'] === 'string' && pair['en'] ? pair['en'] : <em>none</em>}
        </span>
        <span className="cmp__ar" lang="ar" dir="rtl">
          {typeof pair['ar'] === 'string' && pair['ar'] ? pair['ar'] : <em>none</em>}
        </span>
      </>
    );
  }
  return value === null || value === undefined || value === '' ? (
    <em>none</em>
  ) : (
    <span dir="auto">{String(value)}</span>
  );
}

/** The compared columns as a table: field, live now, yours. */
export function CompareTable({ rows }: { rows: readonly CompareRow[] }) {
  if (rows.length === 0) return <p className="admin-sub">Nothing differs now.</p>;
  return (
    <div className="table-wrap cmp" role="region" aria-label="Live and yours" tabIndex={0}>
      <table className="data">
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Live now</th>
            <th scope="col">Yours</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.column}>
              <th scope="row">{row.label}</th>
              <td>
                <Side value={row.live} kind={row.kind} />
              </td>
              <td>
                <Side value={row.yours} kind={row.kind} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A column in the editor's words: the field that writes it, else the column itself. */
function labelOfColumn(fields: readonly FieldDef[], column: string): string {
  return fields.find((f) => columnOf(f) === column)?.label ?? column.replace(/_/g, ' ');
}

export default function DraftNotice({ save, fields, noun, backHref }: DraftNoticeProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [compare, setCompare] = useState<readonly CompareRow[] | null>(null);
  if (save.mode !== 'draft') return null;
  const draft: EditorDraft | null = save.draft ?? null;
  const kind = draft
    ? pendingKindOf({ draft, pendingRemoval: save.pendingRemoval === true })
    : save.pendingRemoval
      ? 'removal'
      : null;
  if (!kind && !save.gone) return null;

  const conflictColumns = draft?.conflict ?? [];
  const live = save.status !== 'saving' && !save.busy;

  async function discard(undo: boolean) {
    if (!draft) return;
    if (!undo) {
      const ok = await confirmDialog({
        message: `Discard this change? Your unpublished changes to this ${noun} will be thrown away. The live site doesn’t change.`,
        confirmLabel: 'Discard',
      });
      if (!ok) return;
    }
    setBusy(true);
    setError('');
    try {
      await adminFetch(`/api/admin/drafts/${draft.id}?version=${draft.version}`, {
        method: 'DELETE',
      });
      announcePending();
      if (draft.op === 'create' && backHref) window.location.href = backHref;
      else await save.reloadTheirs();
    } catch (err) {
      setError(
        err instanceof AdminApiError && err.info.error === 'draft-conflict'
          ? 'This change moved since you opened it. Reload the page to see it.'
          : describeError(err),
      );
    } finally {
      setBusy(false);
    }
  }

  async function resolve(choice: 'keepMine' | 'useLive') {
    if (!draft) return;
    if (save.dirty || save.busy) {
      // An edit not saved yet would be lost under the settled change: save it first.
      save.flush?.();
      setError('Your latest edits are being saved. Try again in a moment.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const row = await adminFetch<Record<string, unknown>>(
        `/api/admin/drafts/${draft.id}/resolve`,
        { method: 'POST', body: { version: draft.version, [choice]: [...conflictColumns] } },
      );
      announcePending();
      setCompare(null);
      if ('draft' in row && row['draft'] === null && 'resolved' in row) await save.reloadTheirs();
      else save.adoptRow?.(row);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function showCompare() {
    if (!draft) return;
    if (compare) {
      setCompare(null);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const answer = await adminFetch<{ columns: CompareRow[] }>(
        `/api/admin/drafts/${draft.id}/compare`,
      );
      setCompare(answer.columns);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const missing = draft?.liveMissing === true;
  const line = save.gone
    ? DRAFT_GONE_WORDS[save.gone]
    : missing
      ? 'This item was removed on the live site. Discard the change.'
      : draft?.invalid
        ? 'This change can no longer be read. Discard it.'
        : kind
          ? LINES[kind]
          : '';

  return (
    <div className="draft-note" data-kind={save.gone ? 'gone' : (kind ?? 'none')}>
      <div className="draft-note__head">
        {kind && <PendingBadge kind={kind} />}
        <p className="draft-note__line" role={save.gone ? 'alert' : undefined}>
          {line}
          {kind === 'conflict' && conflictColumns.length > 0 && (
            <>
              {' '}
              <span className="draft-note__cols">
                {conflictColumns.map((c) => labelOfColumn(fields, c)).join(', ')}
              </span>
            </>
          )}
        </p>
        <div className="toolbar draft-note__acts">
          {kind === 'removal' && draft && (
            <button type="button" disabled={busy} onClick={() => void discard(true)}>
              Undo removal
            </button>
          )}
          {draft && kind !== 'removal' && kind !== 'scheduled' && (
            <button
              type="button"
              data-variant="danger"
              disabled={busy}
              onClick={() => void discard(false)}
            >
              Discard changes
            </button>
          )}
        </div>
      </div>
      {kind === 'conflict' && !missing && conflictColumns.length > 0 && (
        <div className="draft-note__conflict">
          <div className="toolbar">
            <button type="button" disabled={busy || !live} onClick={() => void resolve('keepMine')}>
              Keep my version
            </button>
            <button type="button" disabled={busy || !live} onClick={() => void resolve('useLive')}>
              Use the live version
            </button>
            <button
              type="button"
              aria-expanded={compare !== null}
              onClick={() => void showCompare()}
            >
              Compare
            </button>
          </div>
          {compare && <CompareTable rows={compare} />}
        </div>
      )}
      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
