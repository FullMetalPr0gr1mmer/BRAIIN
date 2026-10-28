import { useEffect, useRef, useState } from 'react';
import EditorForm from '@/components/admin/fields/EditorForm';
import Drawer from '@/components/admin/kit/Drawer';
import Note from '@/components/admin/kit/Note';
import ResourceTable, { EDGE_NOT_SYNCED } from '@/components/admin/screens/resources/ResourceTable';
import { toast } from '@/lib/admin/toast';
import { uiFor } from '@/lib/admin/uiSchema';
import { useEntitySave } from '@/lib/admin/useEntitySave';

// The Redirects tab of /admin/seo (Admin v2 U10, AV-19 D10): the redirects list as before
// (ResourceTable: the "Sync to edge" line, search, Delete), with "Edit <rule>" and "New
// redirect" opening a drawer instead of another page. The form is the redirects resource's
// own (its fields, help text and refusals), saved through useEntitySave like every editor;
// a save closes the drawer and re-reads the list and the edge line. The rows' links and
// /admin/redirects/new and /admin/redirects/<id> still work without JavaScript.
//
// Redirects reach the edge at once (KV, rebuilt by every save): releases do not stage them
// yet, so the form's help says "within a minute of saving" (R12/R14 own that copy when they
// switch on).

const RESOURCE = 'redirects';

interface RedirectFormProps {
  id: string | null;
  /** Admin v2 R12b: the list was read through the release, so a create says so. */
  staged: boolean;
  onDone: (edgeMissed: boolean) => void;
}

function RedirectForm({ id, staged, onDone }: RedirectFormProps) {
  const ui = uiFor(RESOURCE);
  const save = useEntitySave({ kind: 'resource', slug: ui.slug, staged }, id, {
    fields: ui.fields,
    onCreated: (row) => onDone(row['kvSynced'] === false),
  });
  // An edit is done once its save lands: the reducer has then read the answer's `kvSynced`
  // (edgeMissed), which the save's own promise does not carry. A create reports through
  // onCreated above.
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (id !== null && save.savedAt !== null && save.status === 'saved') {
      done.current(save.edgeMissed);
    }
  }, [id, save.savedAt, save.status, save.edgeMissed]);
  return (
    <EditorForm
      save={save}
      fields={ui.fields}
      submitLabel={id === null ? `Create ${ui.singular.toLowerCase()}` : 'Save changes'}
    />
  );
}

export default function RedirectsTab() {
  const ui = uiFor(RESOURCE);
  // null: closed; '' : a new rule; else the rule's id.
  const [open, setOpen] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [missed, setMissed] = useState(false);
  // Admin v2 R12b: whether the list the New button sits on was read through the release.
  const [staged, setStaged] = useState(false);

  return (
    <div>
      {missed && (
        <Note tone="err" role="alert">
          {EDGE_NOT_SYNCED}
        </Note>
      )}
      <ResourceTable
        resource={RESOURCE}
        epoch={epoch}
        onEdit={(row) => setOpen(row.id)}
        onCreate={(throughRelease) => {
          setStaged(throughRelease);
          setOpen('');
        }}
      />
      <Drawer
        open={open !== null}
        onClose={() => setOpen(null)}
        title={open ? `Edit ${ui.singular.toLowerCase()}` : `New ${ui.singular.toLowerCase()}`}
        dismissible={false}
      >
        {open !== null && (
          <RedirectForm
            key={open || 'new'}
            id={open || null}
            staged={staged}
            onDone={(edgeMissed) => {
              setMissed(edgeMissed);
              toast(open ? 'Redirect saved.' : 'Redirect created.', 'ok');
              setOpen(null);
              setEpoch((n) => n + 1);
            }}
          />
        )}
      </Drawer>
    </div>
  );
}
