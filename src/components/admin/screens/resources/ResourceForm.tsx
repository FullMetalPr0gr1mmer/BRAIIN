import EditorForm from '@/components/admin/fields/EditorForm';
import { saveModeFor } from '@/lib/admin/saveMode';
import { uiFor } from '@/lib/admin/uiSchema';
import { useEntitySave } from '@/lib/admin/useEntitySave';
import { EDGE_NOT_SYNCED } from './ResourceTable';

// The create/edit form for every CRUD resource, driven by RESOURCE_UI.
//
// ── The version field is the whole point of the save path ────────────────────────
// The form loads a row, remembers its `version`, and sends that back on save. If a
// colleague saved in between, the server answers 409 and this shows "someone else saved
// changes" rather than silently overwriting their work. Last-write-wins is the default
// behaviour of every naive CMS form and it loses data quietly — the author never finds
// out, and neither does the person whose paragraph vanished.
//
// Since Admin v2 F5a the save is useEntitySave's (src/lib/admin/useEntitySave.ts, the
// rules in the pure entitySave.ts) and the form is EditorForm's; this screen names what it
// edits. Kept as they were: a new record starts from the create schema's defaults; a
// create opens the record's edit screen, with `?edge=missed` when the edge snapshot missed
// it (redirects); an untouched datetime keeps its stored seconds; "Version N".

export interface ResourceFormProps {
  resource: string;
  /** Row id, or `null` to create. */
  id: string | null;
}

export default function ResourceForm({ resource, id }: ResourceFormProps) {
  const ui = uiFor(resource);
  const target = { kind: 'resource', slug: ui.slug } as const;
  const save = useEntitySave(target, id, { fields: ui.fields, mode: saveModeFor(target) });

  return (
    <EditorForm
      save={save}
      fields={ui.fields}
      submitLabel={save.isNew ? `Create ${ui.singular.toLowerCase()}` : 'Save changes'}
      back={{ href: `/admin/${ui.slug}`, label: `Back to ${ui.title.toLowerCase()}` }}
    >
      {/* A resource with an edge snapshot (redirects) reports `kvSynced` on every write.
          False is a committed row the public request path does not see yet, said with
          the maintenance panel's wording, and carried across the create → edit navigation
          as `?edge=missed` (the create response is gone once the page changes). */}
      {save.edgeMissed && (
        <p className="msg" data-kind="error" role="alert">
          {EDGE_NOT_SYNCED}
        </p>
      )}
    </EditorForm>
  );
}
