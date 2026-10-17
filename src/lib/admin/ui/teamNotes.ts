import type { SingletonUi } from './types';

// The team notes (Admin v2 U1): one shared note per tenant, edited in place on the dashboard
// through the field kit's singleton form (GET and PATCH /api/admin/dashboard/notes). The
// limits are the schema's and the database's (packages/schemas/dashboard.ts, 0060).
export const teamNotesUi: SingletonUi = {
  endpoint: '/api/admin/dashboard/notes',
  title: 'Team notes',
  fields: [
    {
      name: 'body',
      label: 'Team notes',
      kind: 'textarea',
      maxLength: 2000,
      help: 'For the team. Do not paste client e-mail addresses or phone numbers here.',
    },
  ],
};
