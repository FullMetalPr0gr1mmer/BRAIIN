// Zod-free on purpose: this module ships in the admin client bundle.
import { SECTION_TYPES } from '@schemas/sectionTypes';
import { SORT_FIELD } from './fields';
import type { ResourceUi } from './types';

// Page sections: the list and the form at /admin/sections.
export const sectionsUi: ResourceUi = {
  slug: 'sections',
  title: 'Page sections',
  singular: 'Section',
  reorder: true,
  columns: [
    { key: 'type', label: 'Type' },
    { key: 'visible', label: 'Visible', kind: 'boolean' },
    { key: 'sort_order', label: 'Order' },
    { key: 'updated_at', label: 'Updated', kind: 'date' },
  ],
  fields: [
    {
      name: 'pageId',
      label: 'Page',
      kind: 'relation',
      required: true,
      relation: { resource: 'pages', labelKey: 'title' },
    },
    {
      name: 'type',
      label: 'Section type',
      kind: 'select',
      required: true,
      // The canonical list (packages/schemas/sections.ts) — the server rejects anything else.
      options: SECTION_TYPES.map((t) => ({ value: t, label: t })),
    },
    {
      name: 'content',
      label: 'Content',
      kind: 'sectionContent',
      typeField: 'type',
      help: 'Optional per-type overrides of the built-in copy, validated against the section type on save.',
    },
    { name: 'visible', label: 'Visible', kind: 'checkbox' },
    {
      name: 'isPlaceholder',
      label: 'Design placeholder',
      kind: 'checkbox',
      help: 'Seeded demo content. In production a placeholder cannot be made visible — replace the copy, then untick.',
    },
    SORT_FIELD,
  ],
};
