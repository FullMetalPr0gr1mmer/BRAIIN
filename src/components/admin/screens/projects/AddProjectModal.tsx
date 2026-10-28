import { useMemo, useRef } from 'react';
import Modal from '@/components/admin/kit/Modal';
import EditorForm from '@/components/admin/fields/EditorForm';
import { saveModeFor } from '@/lib/admin/saveMode';
import { uiFor, type FieldDef } from '@/lib/admin/uiSchema';
import { useEntitySave, type EntitySave } from '@/lib/admin/useEntitySave';
import { slugify } from '../services/model';

// Add project (Admin v2 U6, AV-15: "an EN and AR title, slug and type, created as a draft. It
// never clones another project"): the prototype copied its first project into the new one;
// here a new project starts empty but for its name, type and address, as a draft at the end of
// the catalogue, and its editor opens (useEntitySave's create path). The address follows the
// English name until it is typed in itself. The server validates as for any create.

export interface AddProjectModalProps {
  open: boolean;
  onClose: () => void;
  sortOrder: number;
  /** Admin v2 R12b: the list it opens from was read through the release (SaveTarget `staged`). */
  staged?: boolean | undefined;
}

function modalFields(): { drawn: FieldDef[]; sent: FieldDef[] } {
  const ui = uiFor('portfolio');
  const byName = new Map(ui.fields.map((f) => [f.name, f]));
  const pick = (name: string) => byName.get(name)!;
  const drawn: FieldDef[] = [
    { ...pick('title'), label: 'Project name' },
    { ...pick('projectType'), label: 'Type', help: 'For example “Brand film” or “Rebrand”.' },
    {
      ...pick('slug'),
      label: 'Link (slug)',
      help: 'The case study’s address: /portfolio/<slug>. Made from the English name.',
    },
  ];
  return { drawn, sent: [...drawn, pick('status'), pick('sortOrder')] };
}

export default function AddProjectModal({
  open,
  onClose,
  sortOrder,
  staged = false,
}: AddProjectModalProps) {
  const fields = useMemo(modalFields, []);
  const save = useEntitySave({ kind: 'resource', slug: 'portfolio', staged }, null, {
    fields: fields.sent,
    mode: saveModeFor({ kind: 'resource', slug: 'portfolio' }),
    defaults: { status: 'draft', sortOrder },
  });
  const typedSlug = useRef(false);
  const withSlug: EntitySave = {
    ...save,
    set(name, value) {
      save.set(name, value);
      if (name === 'slug') typedSlug.current = true;
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
      title="Add a project"
      sub="It is created as a draft. Write the rest in its editor."
      dismissible={false}
    >
      <EditorForm
        save={withSlug}
        fields={fields.drawn}
        submitLabel="Create project"
        initialLanguage="both"
      />
    </Modal>
  );
}
