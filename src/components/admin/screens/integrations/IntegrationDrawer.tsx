import { useMemo, useRef, useState } from 'react';
import Drawer from '@/components/admin/kit/Drawer';
import Icon from '@/components/admin/kit/Icon';
import Note from '@/components/admin/kit/Note';
import EditorForm from '@/components/admin/fields/EditorForm';
import { adminFetch, describeError } from '@/lib/admin/client';
import { confirmDialog } from '@/lib/admin/confirm';
import { removeQuestion, type IntegrationTile } from '@/lib/admin/integrations/tiles';
import type { FieldDef } from '@/lib/admin/uiSchema';
import { useEntitySave } from '@/lib/admin/useEntitySave';

// One integration's drawer (Admin v2 U11, the prototype's opsIntegrationDrawer without its
// fake "Test connection"): the tile's one field, saved by useEntitySave against the
// integrations singleton and drawn by EditorForm, so a 409 keeps what was typed ("Reload
// their version") and a 422 lands on the field with the schema's words. Integrations are
// immediate (P-3): a save is live at once. Mounted only while open, so each opening reads
// the row afresh. Not dismissed by a press on the scrim (a form: a stray press keeps its
// input). Remove, shown once a value is saved, asks first and saves null.

export const INTEGRATIONS_ENDPOINT = '/api/admin/integrations';

export interface IntegrationDrawerProps {
  tile: IntegrationTile;
  onClose: () => void;
}

export default function IntegrationDrawer({ tile, onClose }: IntegrationDrawerProps) {
  const field = tile.field as FieldDef;
  // One array for the drawer's life: a new one would reload the row and drop what was typed.
  const fields = useMemo(() => [field], [field]);
  const save = useEntitySave({ kind: 'singleton', endpoint: INTEGRATIONS_ENDPOINT }, null, {
    fields,
  });
  const [open, setOpen] = useState(true);
  const [removeError, setRemoveError] = useState('');
  const [busy, setBusy] = useState(false);

  // What is saved: the value whenever the form is clean (just loaded, or just saved).
  const committed = useRef<unknown>(null);
  if (!save.busy && !save.dirty && !save.loadError) committed.current = save.values[field.name];
  const saved = typeof committed.current === 'string' && committed.current !== '';

  async function remove() {
    const confirmed = await confirmDialog({
      message: removeQuestion(tile),
      confirmLabel: 'Remove',
    });
    if (!confirmed) return;
    setBusy(true);
    setRemoveError('');
    try {
      await adminFetch(INTEGRATIONS_ENDPOINT, {
        method: 'PATCH',
        body: { [field.name]: null, version: save.version },
      });
      setOpen(false);
    } catch (err) {
      setRemoveError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={tile.name}
      dismissible={false}
      footer={
        saved ? (
          <div className="int-drawer__foot">
            <button
              type="button"
              data-variant="danger"
              disabled={busy || save.busy}
              onClick={() => void remove()}
            >
              <Icon name="trash" size={14} />
              Remove
            </button>
            {removeError && (
              <p className="msg" data-kind="error" role="alert">
                {removeError}
              </p>
            )}
          </div>
        ) : undefined
      }
    >
      <div className="int-drawer">
        <p className="int-drawer__desc">{tile.description}</p>
        <EditorForm save={save} fields={fields} submitLabel="Save">
          {tile.notes.map((note) => (
            <Note key={note.text} tone={note.tone}>
              {note.text}
            </Note>
          ))}
          {tile.saved && save.status === 'saved' && saved && (
            <Note tone={tile.saved.tone} role="status">
              {tile.saved.text}
            </Note>
          )}
        </EditorForm>
      </div>
    </Drawer>
  );
}
