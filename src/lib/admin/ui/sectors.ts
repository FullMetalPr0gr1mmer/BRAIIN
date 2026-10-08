import { SORT_FIELD } from './fields';
import type { ResourceUi } from './types';

// Sectors: the list and the form at /admin/sectors.
export const sectorsUi: ResourceUi = {
  slug: 'sectors',
  title: 'Sectors',
  singular: 'Sector',
  reorder: true,
  columns: [
    { key: 'name', label: 'Name', kind: 'bilingual' },
    { key: 'slug', label: 'Slug' },
    { key: 'visible', label: 'Visible', kind: 'boolean' },
  ],
  fields: [
    {
      name: 'slug',
      label: 'Slug',
      kind: 'slug',
      required: true,
      help: 'Used in filter links: /portfolio/all?sector=<slug>.',
    },
    { name: 'name', label: 'Name', kind: 'bilingual', required: true },
    { name: 'visible', label: 'Visible', kind: 'checkbox', defaultValue: true },
    SORT_FIELD,
  ],
};
