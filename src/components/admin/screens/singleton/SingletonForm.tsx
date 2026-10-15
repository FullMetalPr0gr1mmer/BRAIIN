import EditorForm from '@/components/admin/fields/EditorForm';
import { saveModeFor } from '@/lib/admin/saveMode';
import { singletonFor } from '@/lib/admin/uiSchema';
import { useEntitySave } from '@/lib/admin/useEntitySave';

// Editor for the per-tenant config singletons: SEO defaults, general settings,
// integrations, Style-Finder logic.
//
// `version: 0` is meaningful here rather than being a placeholder. A tenant that has
// never saved this config has NO ROW — the GET endpoint answers with defaults and
// version 0 — and the PATCH treats 0 as "I am creating it". That is what makes the
// optimistic-lock story hold across the create boundary: two admins who both open a
// fresh settings page and both save produce one insert and one 409, not two inserts or
// a silent overwrite.
//
// Since Admin v2 F5a the save is useEntitySave's (the version-0 rule is in the pure
// entitySave.ts, tested there and by tests/lib/singletonFirstSave.spec.ts on the routes)
// and the form is EditorForm's, which says "Not saved yet" until the first save.

export interface SingletonFormProps {
  /** Key into SINGLETON_UI. */
  config: string;
}

export default function SingletonForm({ config }: SingletonFormProps) {
  const ui = singletonFor(config);
  const target = { kind: 'singleton', endpoint: ui.endpoint } as const;
  const save = useEntitySave(target, null, { fields: ui.fields, mode: saveModeFor(target) });

  return (
    <EditorForm save={save} fields={ui.fields} submitLabel={`Save ${ui.title.toLowerCase()}`} />
  );
}
