import type { SingletonUi } from './types';

// Maintenance mode (/admin/maintenance, Admin v2 U9b; the prototype's `opsMaintenanceCard`):
// the page visitors see while the site is down, when it comes back, and who still sees the
// site. The GET answers the flat form shape in camelCase (src/lib/admin/maintenance.ts
// formOf), so every field names its own key as its column. `active` is not drawn: the
// panel's Turn on / Turn off flip it (MaintenancePanel), and Save keeps it as loaded.

export const maintenanceUi: SingletonUi = {
  endpoint: '/api/admin/settings/maintenance',
  title: 'Maintenance mode',
  fields: [
    { name: 'active', label: 'Maintenance mode is on', kind: 'checkbox', column: 'active' },
    {
      name: 'title',
      label: 'Headline',
      kind: 'bilingual',
      column: 'title',
      nullable: true,
      maxLength: 80,
      help: "Leave it empty for the built-in headline: We're making something new.",
    },
    {
      name: 'message',
      label: 'Message',
      kind: 'bilingual',
      column: 'message',
      nullable: true,
      multiline: true,
      maxLength: 280,
      help: 'Leave it empty for the built-in message, which matches the buttons shown.',
    },
    {
      name: 'background',
      label: 'Background',
      kind: 'select',
      column: 'background',
      options: [
        { value: 'image', label: 'The hero image' },
        { value: 'black', label: 'Plain black' },
      ],
    },
    {
      name: 'showContact',
      label: 'Show email and WhatsApp buttons',
      kind: 'checkbox',
      column: 'showContact',
      help: 'The email and WhatsApp number from General settings. WhatsApp shows only when a number is set.',
    },
    {
      name: 'until',
      label: 'Back on (optional)',
      kind: 'date',
      column: 'until',
      help: 'Maintenance turns off by itself at midnight that day.',
    },
    {
      name: 'showDate',
      label: 'Show the date to visitors',
      kind: 'checkbox',
      column: 'showDate',
    },
    {
      name: 'staffBypass',
      label: 'Signed in team still sees the site',
      kind: 'checkbox',
      column: 'staffBypass',
      help: 'Anyone signed in to this admin sees the real site. If their sign in cannot be checked, they see the maintenance page.',
    },
    {
      name: 'allowlist',
      label: 'Also allow these IP addresses',
      kind: 'chips',
      column: 'allowlist',
      chips: { maxLength: 45 },
      maxItems: 50,
      help: 'For the client or an outside tester. Press Enter or type a comma after each.',
    },
  ],
  groups: [
    {
      id: 'page',
      title: 'The page',
      fields: ['title', 'message', 'background', 'showContact'],
    },
    {
      id: 'back',
      title: 'Coming back',
      fields: ['until', 'showDate'],
    },
    {
      id: 'who',
      title: 'Who still sees the site',
      fields: ['staffBypass', 'allowlist'],
    },
  ],
};
