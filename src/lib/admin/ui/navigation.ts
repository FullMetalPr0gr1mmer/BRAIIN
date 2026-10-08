import { SORT_FIELD } from './fields';
import type { ResourceUi } from './types';

// Navigation: the list and the form at /admin/navigation.
export const navigationUi: ResourceUi = {
  slug: 'navigation',
  title: 'Navigation',
  singular: 'Nav item',
  reorder: true,
  columns: [
    { key: 'label', label: 'Label', kind: 'bilingual' },
    { key: 'href', label: 'Link' },
    { key: 'location', label: 'Location' },
    { key: 'visible', label: 'Visible', kind: 'boolean' },
    { key: 'is_key', label: 'Key link', kind: 'boolean' },
  ],
  fields: [
    {
      name: 'location',
      label: 'Location',
      kind: 'select',
      options: [
        { value: 'header', label: 'Header' },
        { value: 'footer', label: 'Footer' },
      ],
      required: true,
    },
    { name: 'label', label: 'Label', kind: 'bilingual', required: true },
    { name: 'href', label: 'Link', kind: 'text', required: true },
    { name: 'parentId', label: 'Parent item id', kind: 'text' },
    { name: 'visible', label: 'Visible', kind: 'checkbox' },
    {
      name: 'isKey',
      label: 'Key link (stays in the header bar on phones)',
      kind: 'checkbox',
      help: 'At <=900px the header shows only this link; the rest move into the menu. One per menu — untick the current key link before ticking another.',
    },
    SORT_FIELD,
  ],
};
