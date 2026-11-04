import { useEffect, type MutableRefObject } from 'react';
import EditorForm from '@/components/admin/fields/EditorForm';
import { historyTargetOf } from '@/lib/admin/historyTarget';
import { saveModeFor } from '@/lib/admin/saveMode';
import { useEntitySave, type EntitySave } from '@/lib/admin/useEntitySave';
import type { TemplateKind } from '@schemas/templateCopyKeys';
import { useSaveSignal } from './useSaveSignal';
import { ITEM_FIELDS, ITEM_TARGET, NOUN, fullEditorHref } from './model';
import type { TemplateItem } from './types';

// The fields column on "This service" / "This project" (Admin v2 E3, ui.md "Template editors"):
// the words of the item a template page shows, saved exactly as its full editor saves them
// (the same resource route, PATCH /api/admin/services/<id> or /api/admin/portfolio/<id>, with
// the full editor's own field definitions and the version it loaded), so there is one write
// path to the row: live with a 409 while releases are off, a pending change once they are on
// (R12). Everything else of the item (its address, discipline, media, case study, SEO, status)
// stays in the full editor, which the bar links to.

export interface ItemPanelProps {
  kind: TemplateKind;
  item: TemplateItem;
  /** The role writes the item (services.write / portfolio.write). */
  write: boolean;
  formRef: MutableRefObject<EntitySave | null>;
  /** A save of this form landed: the preview reloads. */
  onSaved: () => void;
  /** Whether the form saves pending changes (releases on) or live, as its last answer said. */
  onMode: (release: boolean) => void;
}

export default function ItemPanel({ kind, item, write, formRef, onSaved, onMode }: ItemPanelProps) {
  const target = ITEM_TARGET[kind];
  const save = useEntitySave(target, item.id, {
    fields: ITEM_FIELDS[kind],
    mode: saveModeFor(target),
    onRow: useSaveSignal(onSaved, onMode),
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

  const noun = NOUN[kind];
  return (
    <section className="pe__panel" aria-labelledby="tpl-item-h">
      <div className="pe__panel-h">
        <div className="pe__panel-t">
          <h2 id="tpl-item-h" className="pe__h">
            This {noun}
          </h2>
          <p className="pe__tiny">
            Its own words on its page. Everything else of it is in{' '}
            <a href={fullEditorHref(kind, item.id)}>its full editor</a>.
          </p>
        </div>
      </div>
      <EditorForm
        save={save}
        fields={ITEM_FIELDS[kind]}
        languageBar="page"
        submitLabel="Save changes"
        noun={noun}
        history={historyTargetOf(target, item.id)}
        readOnly={!write}
        readOnlyNote={`You can read this ${noun}. Your role cannot change it.`}
      />
    </section>
  );
}
