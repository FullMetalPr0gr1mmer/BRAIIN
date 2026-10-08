import { SCHEDULED_FIELD, STATUS_FIELD } from './fields';
import type { ResourceUi } from './types';

// Pages: the list and the form at /admin/pages.
export const pagesUi: ResourceUi = {
  slug: 'pages',
  title: 'Pages',
  singular: 'Page',
  hasStatus: true,
  columns: [
    { key: 'title', label: 'Title', kind: 'bilingual' },
    { key: 'slug', label: 'Slug' },
    { key: 'status', label: 'Status', kind: 'status' },
    { key: 'nav_visible', label: 'In nav', kind: 'boolean' },
    { key: 'updated_at', label: 'Updated', kind: 'date' },
  ],
  fields: [
    { name: 'slug', label: 'Slug', kind: 'slug', required: true },
    { name: 'title', label: 'Title', kind: 'bilingual', required: true },
    { name: 'navVisible', label: 'Show in navigation', kind: 'checkbox', defaultValue: true },
    STATUS_FIELD,
    SCHEDULED_FIELD,
  ],
};
