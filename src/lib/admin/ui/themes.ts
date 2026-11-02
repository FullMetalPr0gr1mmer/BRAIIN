import type { ResourceUi } from './types';

// Themes (Admin v2 E4): the editor at /admin/appearance/theme draws its own controls over these
// fields (src/components/admin/screens/theme/ThemeScreen.tsx) and saves them through the
// `themes` resource; the server compiles the tokens from `settings`. The retired list and form
// at /admin/themes/** answer there with a 302.
export const themesUi: ResourceUi = {
  slug: 'themes',
  title: 'Theme',
  singular: 'Theme',
  columns: [
    { key: 'name', label: 'Name' },
    { key: 'is_active', label: 'Active', kind: 'boolean' },
    { key: 'updated_at', label: 'Updated', kind: 'date' },
  ],
  fields: [
    { name: 'name', label: 'Name', kind: 'text', defaultValue: 'Site theme' },
    { name: 'settings', label: 'Theme', kind: 'json' },
    { name: 'isActive', label: 'Active theme', kind: 'checkbox', defaultValue: true },
  ],
};
