import { useMemo, useRef, useState } from 'react';
import Modal from '@/components/admin/kit/Modal';
import EditorForm from '@/components/admin/fields/EditorForm';
import { saveModeFor } from '@/lib/admin/saveMode';
import { uiFor, type FieldDef } from '@/lib/admin/uiSchema';
import { useEntitySave, type EntitySave } from '@/lib/admin/useEntitySave';
import { slugify } from './model';

// Add service (Admin v2 U5, AV-14 "Add service modal (EN and AR name)"): the service's name in
// both languages and its address, created as a draft in this discipline, at the end of its
// list; then its editor opens (useEntitySave's create path), where the rest is written. The
// address follows the English name until it is typed in itself. The server validates as for
// any create (a taken address is a 422 on the field, said in the modal).

export interface AddServiceModalProps {
  open: boolean;
  onClose: () => void;
  disciplineId: string;
  disciplineName: string;
  sortOrder: number;
}

/** The fields the modal draws, and the ones its save sends (the discipline and the order too). */
function modalFields(): { drawn: FieldDef[]; sent: FieldDef[] } {
  const ui = uiFor('services');
  const byName = new Map(ui.fields.map((f) => [f.name, f]));
  const pick = (name: string) => byName.get(name)!;
  const drawn: FieldDef[] = [
    { ...pick('title'), label: 'Service name' },
    { ...pick('slug'), help: 'The page address: /services/<slug>. Made from the English name.' },
  ];
  return {
    drawn,
    sent: [...drawn, pick('disciplineId'), pick('status'), pick('sortOrder')],
  };
}

export default function AddServiceModal({
  open,
  onClose,
  disciplineId,
  disciplineName,
  sortOrder,
}: AddServiceModalProps) {
  const fields = useMemo(modalFields, []);
  const save = useEntitySave({ kind: 'resource', slug: 'services' }, null, {
    fields: fields.sent,
    mode: saveModeFor({ kind: 'resource', slug: 'services' }),
    defaults: { disciplineId, status: 'draft', sortOrder },
  });
  // The address follows the English name until the person writes it themselves.
  const typedSlug = useRef(false);
  const [, rerender] = useState(0);
  const withSlug: EntitySave = {
    ...save,
    set(name, value) {
      save.set(name, value);
      if (name === 'slug') {
        typedSlug.current = true;
        rerender((n) => n + 1);
      }
      if (name === 'title' && !typedSlug.current && value && typeof value === 'object') {
        const en = (value as Record<string, unknown>)['en'];
        save.set('slug', slugify(typeof en === 'string' ? en : ''));
      }
    },
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a service"
      sub={`It is created as a draft in ${disciplineName}. Write the rest in its editor.`}
      dismissible={false}
    >
      <EditorForm
        save={withSlug}
        fields={fields.drawn}
        submitLabel="Create service"
        initialLanguage="both"
      />
    </Modal>
  );
}
