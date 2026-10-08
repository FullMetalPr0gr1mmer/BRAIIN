import type { ResourceUi } from './types';

// Themes: the list and the form at /admin/themes.
export const themesUi: ResourceUi = {
  slug: 'themes',
  title: 'Themes',
  singular: 'Theme',
  columns: [
    { key: 'name', label: 'Name' },
    { key: 'is_active', label: 'Active', kind: 'boolean' },
    { key: 'updated_at', label: 'Updated', kind: 'date' },
  ],
  fields: [
    { name: 'name', label: 'Name', kind: 'text', required: true },
    {
      name: 'tokens',
      label: 'Tokens (JSON)',
      kind: 'json',
      help: 'CSS custom properties only: keys must start with “--”, values may not contain ; { } < >.',
    },
    { name: 'isActive', label: 'Active theme', kind: 'checkbox' },
  ],
};
