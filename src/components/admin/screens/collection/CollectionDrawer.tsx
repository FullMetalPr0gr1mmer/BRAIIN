import { useEffect, useMemo, useRef, useState } from 'react';
import Drawer from '@/components/admin/kit/Drawer';
import Icon from '@/components/admin/kit/Icon';
import Note from '@/components/admin/kit/Note';
import EditorForm from '@/components/admin/fields/EditorForm';
import FieldShell, { describedBy } from '@/components/admin/fields/FieldShell';
import { adminFetch, describeError } from '@/lib/admin/client';
import { announcePending, STAGED_DELETE } from '@/lib/admin/releaseEvents';
import { confirmDialog } from '@/lib/admin/confirm';
import { saveModeFor } from '@/lib/admin/saveMode';
import { uiFor, type FieldDef } from '@/lib/admin/uiSchema';
import { useEntitySave } from '@/lib/admin/useEntitySave';
import {
  deleteOutcome,
  deleteQuestion,
  textOf,
  type CollectionDef,
  type DeleteOutcome,
} from './collections';
import { drawerFields, SAMPLE_LOCKED, type CollectionPermissions } from './fields';

// The drawer that adds or edits one item of a collection (Admin v2 U7): the kit Drawer
// (`dismissible={false}`: a stray press on the scrim keeps what was typed) around the
// collection's form, saved by useEntitySave and drawn by EditorForm like every editor
// (409 keeps the work, a 422 lands on the field). The footer holds Delete, for the roles
// that may delete (the server decides again: content.archiveDelete, RESTRICTIVE in RLS).
//
// A design sample quote (testimonials, 0028): its words and attribution are read-only
// until "Make this quote real" is switched on; then they are editable, and the one save
// sends the new words, the consent record and the cleared flag together, the sample lock's
// only accepted path. With the switch off the save still carries the stored words, unchanged
// (the lock compares values, so an unchanged sample saves its order or pages).

type Row = Record<string, unknown>;

export interface CollectionDrawerProps {
  def: CollectionDef;
  /** The item's id, or null to add one. */
  id: string | null;
  /** The list's row for it (status, the sample flag), when it has one. */
  listed: Row | null;
  permissions: CollectionPermissions;
  /**
   * Admin v2 R12b: the list the drawer opens from was read through the release, so adding an
   * item says it was made in release mode (SaveTarget `staged`).
   */
  staged?: boolean | undefined;
  /** A new item's starting values (its place at the end of the list). */
  defaults: Row;
  onClose: () => void;
  onCreated: (row: Row) => void;
  onSaved: () => void;
  /**
   * What the Delete did (Admin v2 R12): a live delete, a removal staged for the next publish,
   * or a pending new item thrown away (releases on).
   */
  onDeleted: (outcome: DeleteOutcome) => void;
}

export default function CollectionDrawer({
  def,
  id,
  listed,
  permissions,
  staged = false,
  defaults,
  onClose,
  onCreated,
  onSaved,
  onDeleted,
}: CollectionDrawerProps) {
  const ui = uiFor(def.slug);
  const sample = def.samples === true && listed?.['is_placeholder'] === true;
  // What the save loads and sends: every field, always the same array (a new array would
  // reload the row and drop what was typed). What the form draws follows the switches.
  const payloadFields = useMemo(() => ui.fields, [ui]);
  const [open, setOpen] = useState(true);
  const [makeReal, setMakeReal] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [busy, setBusy] = useState(false);
  const stored = useRef<Row | null>(null);

  const save = useEntitySave({ kind: 'resource', slug: def.slug, staged }, id, {
    fields: payloadFields,
    mode: saveModeFor({ kind: 'resource', slug: def.slug }),
    defaults,
    onCreated: (row) => {
      onCreated(row);
      setOpen(false);
    },
  });

  // An edit that landed: the list reads it again and the drawer closes (the prototype's
  // "Saved" and back to the list). A create goes through onCreated instead.
  const savedAt = save.savedAt;
  const firstSavedAt = useRef(savedAt);
  useEffect(() => {
    if (id !== null && savedAt && savedAt !== firstSavedAt.current) {
      onSaved();
      setOpen(false);
    }
  }, [savedAt]);

  const fields: readonly FieldDef[] = drawerFields(ui.fields, {
    isNew: id === null,
    permissions,
    status: typeof listed?.['status'] === 'string' ? listed['status'] : null,
    sample: sample && !makeReal ? 'locked' : sample ? 'unlocking' : def.samples ? 'real' : 'none',
  });

  function switchReal() {
    if (!makeReal) {
      // Keep the sample's words, so switching back puts them back as they were.
      stored.current = Object.fromEntries(SAMPLE_LOCKED.map((name) => [name, save.values[name]]));
      save.set('isPlaceholder', false);
      setMakeReal(true);
    } else {
      for (const [name, value] of Object.entries(stored.current ?? {})) save.set(name, value);
      save.set('isPlaceholder', true);
      setMakeReal(false);
    }
  }

  async function remove() {
    if (id === null) return;
    const name = listed ? def.rowTitle(listed) : def.noun;
    const confirmed = await confirmDialog({
      message: deleteQuestion(def, name),
      confirmLabel: 'Delete',
    });
    if (!confirmed) return;
    setBusy(true);
    setDeleteError('');
    try {
      // R12: an item read through the release says so, so a switch-off since is refused.
      const marker = save.mode === 'draft' ? STAGED_DELETE : '';
      const result = await adminFetch<Record<string, unknown>>(
        `/api/admin/${def.slug}/${id}${marker}`,
        { method: 'DELETE' },
      );
      // R12: with releases on the answer names the pending removal, or a pending new item
      // thrown away (never on the site, nothing staged).
      const outcome = deleteOutcome(result);
      if (outcome !== 'deleted') announcePending();
      onDeleted(outcome);
      setOpen(false);
    } catch (err) {
      setDeleteError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const title = id === null ? `New ${def.noun}` : `Edit ${def.noun}`;
  const mayDelete = id !== null && permissions.remove;
  const switchId = `coll-real-${def.slug}`;
  const realHint = 'Replace the words and record consent, then save once to make it real.';

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={title}
      dismissible={false}
      footer={
        mayDelete ? (
          <div className="coll__foot">
            <button
              type="button"
              className="btn"
              data-variant="danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              <Icon name="trash" size={14} />
              Delete
            </button>
            {deleteError && (
              <p className="msg" data-kind="error" role="alert">
                {deleteError}
              </p>
            )}
          </div>
        ) : undefined
      }
    >
      <div className="coll__drawer">
        {sample && (
          <>
            <Note tone="warn">
              This is a design sample. Replace the words and record consent to make it real.
            </Note>
            {permissions.write && (
              <FieldShell id={switchId} label="Make this quote real" hint={realHint} inline>
                <button
                  type="button"
                  role="switch"
                  id={switchId}
                  aria-checked={makeReal}
                  aria-labelledby={`${switchId}-label`}
                  aria-describedby={describedBy(switchId, { hint: realHint })}
                  onClick={switchReal}
                />
              </FieldShell>
            )}
            {!makeReal && !save.busy && !save.loadError && <SampleWords values={save.values} />}
          </>
        )}
        <EditorForm save={save} fields={fields} submitLabel={id === null ? 'Add' : 'Save changes'}>
          {def.note && <Note>{def.note}</Note>}
        </EditorForm>
      </div>
    </Drawer>
  );
}

/** A sample's words as the site shows them, read-only until the switch is on. */
function SampleWords({ values }: { values: Row }) {
  const quote = (values['quote'] ?? {}) as Row;
  const en = typeof quote['en'] === 'string' ? quote['en'] : '';
  const ar = typeof quote['ar'] === 'string' ? quote['ar'] : '';
  const author = textOf(values['authorName']);
  return (
    <figure className="coll__sample" aria-label="The sample's words">
      {en && (
        <blockquote lang="en" dir="ltr">
          <p>{en}</p>
        </blockquote>
      )}
      {ar && (
        <blockquote lang="ar" dir="rtl">
          <p>{ar}</p>
        </blockquote>
      )}
      {author && <figcaption dir="auto">{author}</figcaption>}
    </figure>
  );
}
