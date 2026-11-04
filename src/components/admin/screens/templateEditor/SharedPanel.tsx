import { useEffect, useMemo, type MutableRefObject } from 'react';
import EditorForm from '@/components/admin/fields/EditorForm';
import { singletonHistory } from '@/lib/admin/historyTarget';
import { saveModeFor } from '@/lib/admin/saveMode';
import { useEntitySave, type EntitySave } from '@/lib/admin/useEntitySave';
import type { TemplateKind } from '@schemas/templateCopyKeys';
import { useSaveSignal } from './useSaveSignal';
import { SHARED_TARGET, sharedField } from './model';

// The fields column on "Shared text" (Admin v2 E3): the words every page of the template shows
// around its own content, one group per part of the page, each line's built-in words in grey
// under it. Saved through the singleton kernel (PATCH /api/admin/template-copy, pages.write),
// this template's map whole: a line left blank in both languages is not stored, so the page
// shows the built-in words. Live while releases are off, a pending change once they are on
// (R12); History lists the row's versions (singleton history, R14-prep's rule).

const HISTORY = singletonHistory('template_copy');

export interface SharedPanelProps {
  kind: TemplateKind;
  /** The template's built-in words, key by key (the server's props: never in the bundle). */
  builtIn: Readonly<Record<string, unknown>>;
  /** The page the History drawer's Preview opens (the item shown). */
  path: string | null;
  formRef: MutableRefObject<EntitySave | null>;
  /** A save of this form landed: the preview reloads. */
  onSaved: () => void;
  /** Whether the form saves pending changes (releases on) or live, as its last answer said. */
  onMode: (release: boolean) => void;
}

export default function SharedPanel({
  kind,
  builtIn,
  path,
  formRef,
  onSaved,
  onMode,
}: SharedPanelProps) {
  // One field, built once per template: useEntitySave's load depends on `fields`, so a new
  // array every render would read the row again after each render (E8's CI finding).
  const fields = useMemo(() => [sharedField(kind, builtIn)], [kind, builtIn]);
  const save = useEntitySave(SHARED_TARGET, null, {
    fields,
    mode: saveModeFor(SHARED_TARGET),
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

  return (
    <section className="pe__panel" aria-labelledby="tpl-shared-h">
      <div className="pe__panel-h">
        <div className="pe__panel-t">
          <h2 id="tpl-shared-h" className="pe__h">
            Shared text
          </h2>
          <p className="pe__tiny">
            {kind === 'service'
              ? 'The words every service page shows around its own. A change shows on all of them.'
              : 'The words every project page shows around its own. A change shows on all of them.'}{' '}
            Leave a line empty to keep the built-in words, shown in grey.
          </p>
        </div>
      </div>
      <EditorForm
        save={save}
        fields={fields}
        languageBar="page"
        submitLabel="Save shared text"
        noun="shared text"
        history={HISTORY}
        historyOf={{ label: 'Shared text', path }}
      />
    </section>
  );
}
