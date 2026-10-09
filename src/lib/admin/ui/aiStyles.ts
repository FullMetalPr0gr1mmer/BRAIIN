import { SORT_FIELD, STATUS_FIELD } from './fields';
import type { ResourceUi } from './types';

// Style-Finder styles: the list and the form at /admin/ai-styles.
export const aiStylesUi: ResourceUi = {
  slug: 'ai-styles',
  title: 'Style-Finder styles',
  singular: 'Style',
  hasStatus: true,
  reorder: true,
  columns: [
    { key: 'name', label: 'Name', kind: 'bilingual' },
    { key: 'slug', label: 'Slug' },
    { key: 'status', label: 'Status', kind: 'status' },
  ],
  fields: [
    { name: 'slug', label: 'Slug', kind: 'slug', required: true },
    { name: 'name', label: 'Name', kind: 'bilingual', required: true },
    { name: 'description', label: 'Description', kind: 'prose' },
    { name: 'traits', label: 'Traits (JSON)', kind: 'json' },
    { name: 'imageUrl', label: 'Image URL', kind: 'url' },
    SORT_FIELD,
    STATUS_FIELD,
  ],
};
