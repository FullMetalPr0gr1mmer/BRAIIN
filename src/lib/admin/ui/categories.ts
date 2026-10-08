import type { ResourceUi } from './types';

// Categories: the list and the form at /admin/categories.
export const categoriesUi: ResourceUi = {
  slug: 'categories',
  title: 'Categories',
  singular: 'Category',
  columns: [
    { key: 'name', label: 'Name', kind: 'bilingual' },
    { key: 'slug', label: 'Slug' },
  ],
  fields: [
    { name: 'slug', label: 'Slug', kind: 'slug', required: true },
    { name: 'name', label: 'Name', kind: 'bilingual', required: true },
  ],
};
