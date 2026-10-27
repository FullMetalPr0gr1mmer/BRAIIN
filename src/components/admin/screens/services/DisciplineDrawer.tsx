import { useEffect, useRef, useState } from 'react';
import Drawer from '@/components/admin/kit/Drawer';
import Icon from '@/components/admin/kit/Icon';
import EditorForm from '@/components/admin/fields/EditorForm';
import { adminFetch, describeError } from '@/lib/admin/client';
import { confirmDialog } from '@/lib/admin/confirm';
import { saveModeFor } from '@/lib/admin/saveMode';
import { uiFor, type FieldDef } from '@/lib/admin/uiSchema';
import { useEntitySave } from '@/lib/admin/useEntitySave';
import { historyTargetOf } from '@/lib/admin/historyTarget';

// A discipline's drawer (Admin v2 U5, the prototype's editCat): add or edit one, from the
// Services overview and from the discipline's own page. The kit Drawer (`dismissible={false}`:
// a stray press on the scrim keeps what was typed) around the discipline's form, saved by
// useEntitySave and drawn by EditorForm (409 keeps the work, a 422 lands on the field). Every
// field but the order, which the overview's list sets; "Archived" offered only to a role that
// may archive (unless it already is). Delete in the footer for that role (the server decides
// again: content.archiveDelete); a discipline that still holds services is refused by its key,
// said as "Move its services first" (resources/disciplines.ts).

type Row = Record<string, unknown>;

export interface DisciplineDrawerProps {
  /** The discipline's id, or null to add one. */
  id: string | null;
  /** Its stored status, when known (the list's row). */
  status: string | null;
  /** The name the Delete question says. */
  name: string;
  write: boolean;
  archive: boolean;
  /** A new discipline's starting values (its place at the end of the list). */
  defaults: Row;
  onClose: () => void;
  onSaved: (row: Row, created: boolean) => void;
  onDeleted: () => void;
}

/** The drawer's fields: no order field; "Archived" only for a role that may archive. */
export function drawerFields(
  fields: readonly FieldDef[],
  archive: boolean,
  status: string | null,
): FieldDef[] {
  return fields
    .filter((field) => field.name !== 'sortOrder')
    .map((field) =>
      field.name === 'status' && !archive && status !== 'archived' && field.options
        ? { ...field, options: field.options.filter((o) => o.value !== 'archived') }
        : field,
    );
}

export default function DisciplineDrawer({
  id,
  status,
  name,
  write,
  archive,
  defaults,
  onClose,
  onSaved,
  onDeleted,
}: DisciplineDrawerProps) {
  const ui = uiFor('disciplines');
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const save = useEntitySave({ kind: 'resource', slug: 'disciplines' }, id, {
    fields: ui.fields,
    mode: saveModeFor({ kind: 'resource', slug: 'disciplines' }),
    defaults,
    onCreated: (row) => {
      onSaved(row, true);
      setOpen(false);
    },
  });

  // An edit that landed closes the drawer (the prototype's "Saved", back to the list).
  const firstSavedAt = useRef(save.savedAt);
  useEffect(() => {
    if (id !== null && save.savedAt && save.savedAt !== firstSavedAt.current) {
      onSaved(save.values, false);
      setOpen(false);
    }
  }, [save.savedAt]);

  async function remove() {
    if (id === null) return;
    const confirmed = await confirmDialog({
      message: `Delete the discipline ⁨${name}⁩? This cannot be undone.`,
      confirmLabel: 'Delete',
    });
    if (!confirmed) return;
    setBusy(true);
    setDeleteError('');
    try {
      await adminFetch(`/api/admin/disciplines/${id}`, { method: 'DELETE' });
      onDeleted();
      setOpen(false);
    } catch (err) {
      setDeleteError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const readOnly = !write || (!archive && status === 'archived');
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={id === null ? 'New discipline' : `Edit discipline: ${name}`}
      dismissible={false}
      footer={
        id !== null && archive ? (
          <div className="svc__foot">
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
      <EditorForm
        history={historyTargetOf({ kind: 'resource', slug: 'disciplines' }, id)}
        save={save}
        fields={drawerFields(ui.fields, archive, status)}
        submitLabel={id === null ? 'Create discipline' : 'Save changes'}
        readOnly={readOnly}
        readOnlyNote={
          readOnly
            ? status === 'archived' && write
              ? 'This discipline is archived. Only an Admin can change it.'
              : 'You can read this discipline. Your role cannot change it.'
            : undefined
        }
      />
    </Drawer>
  );
}
