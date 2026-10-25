import { useEffect, type MutableRefObject } from 'react';
import EditorForm from '@/components/admin/fields/EditorForm';
import { useEntitySave, type EntitySave } from '@/lib/admin/useEntitySave';
import { PAGE_FIELDS } from './model';
import type { PageEditorPage } from './types';

// The fields column on "Page details" (Admin v2 E1): the page's own title, status and
// schedule, through the pages resource (PATCH /api/admin/pages/<id>), the legacy page form's
// fields less the address, which the site's routes fix (0057). Live with version and 409
// while releases are off; a pending change once they are on (R12).

const PAGE_TARGET = { kind: 'resource', slug: 'pages' } as const;

export interface PagePanelProps {
  page: PageEditorPage;
  formRef: MutableRefObject<EntitySave | null>;
  onRow: (row: Record<string, unknown>) => void;
}

export default function PagePanel({ page, formRef, onRow }: PagePanelProps) {
  const save = useEntitySave(PAGE_TARGET, page.id, {
    fields: PAGE_FIELDS,
    autosave: { idleMs: 800 },
    onRow,
  });
  useEffect(() => {
    formRef.current = save;
  });
  useEffect(
    () => () => {
      formRef.current = null;
    },
    [formRef],
  );

  return (
    <section className="pe__panel" aria-labelledby="pe-panel-h">
      <div className="pe__panel-h">
        <div className="pe__panel-t">
          <h2 id="pe-panel-h" className="pe__h">
            Page details
          </h2>
          <p className="pe__tiny">
            {page.path
              ? `Address ${page.path}, set by the site’s routes.`
              : 'No route of the site shows this page yet.'}
          </p>
        </div>
      </div>
      <EditorForm
        save={save}
        fields={PAGE_FIELDS}
        languageBar="page"
        submitLabel="Save changes"
        noun="page"
      />
    </section>
  );
}
