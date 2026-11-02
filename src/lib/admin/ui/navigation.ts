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
    { key: 'is_heading', label: 'Column heading', kind: 'boolean' },
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
    {
      name: 'href',
      label: 'Link',
      kind: 'text',
      help: 'A page of this site, such as /about, or an https:// link. Leave it empty for a footer column heading.',
    },
    { name: 'parentId', label: 'Parent item id', kind: 'text' },
    { name: 'visible', label: 'Visible', kind: 'checkbox' },
    {
      name: 'isKey',
      label: 'Key link (stays in the header bar on phones)',
      kind: 'checkbox',
      help: 'At <=900px the header shows only this link; the rest move into the menu. One per menu — untick the current key link before ticking another.',
    },
    // Admin v2 E6: a footer column (Appearance › Footer adds and orders them too).
    {
      name: 'isHeading',
      label: 'Footer column heading',
      kind: 'checkbox',
      help: 'A title over a column of footer links, with no link of its own. Footer only, at the top level, up to 4. The links under it make its column.',
    },
    SORT_FIELD,
  ],
};
