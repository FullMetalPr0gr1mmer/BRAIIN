import { SCHEDULED_FIELD, STATUS_FIELD } from './fields';
import type { ResourceUi } from './types';

// Pages: the list and the form at /admin/pages. Whether a page is in the menus is page
// visibility's now (/admin/visibility, Admin v2 U14a), so the old "In nav" column and its
// checkbox are gone; `nav_visible` stays in the table until a contraction drops it.
export const pagesUi: ResourceUi = {
  slug: 'pages',
  title: 'Pages',
  singular: 'Page',
  hasStatus: true,
  columns: [
    { key: 'title', label: 'Title', kind: 'bilingual' },
    { key: 'slug', label: 'Slug' },
    { key: 'status', label: 'Status', kind: 'status' },
    { key: 'updated_at', label: 'Updated', kind: 'date' },
  ],
  fields: [
    { name: 'slug', label: 'Slug', kind: 'slug', required: true },
    { name: 'title', label: 'Title', kind: 'bilingual', required: true },
    STATUS_FIELD,
    SCHEDULED_FIELD,
  ],
};
