import { STUDIO_TIME_ZONES } from '@schemas/timeZones';
import type { SingletonUi } from './types';

// The technical settings row, `site_settings`: the General screen's second form, "Region and
// data" (Admin v2 U9). It saves on its own and at once (P-3: never staged), apart from the
// identity above it. The technical `identity` JSON left the form in U9 (no reader since 0048).

export const settingsUi: SingletonUi = {
  endpoint: '/api/admin/settings',
  title: 'Region and data',
  fields: [
    {
      name: 'timezone',
      label: 'Timezone',
      kind: 'select',
      options: STUDIO_TIME_ZONES,
      help: "The studio's clock: dates and times across the admin, and the day maintenance ends.",
    },
    {
      name: 'retention',
      label: 'How long data is kept',
      kind: 'object',
      help: 'Each can be shortened, never extended past its limit (the PDPL promise).',
      itemFields: [
        {
          name: 'raw_telemetry_days',
          label: 'Raw visit data (days, at most 90)',
          kind: 'number',
        },
        { name: 'leads_months', label: 'Leads (months, at most 24)', kind: 'number' },
        { name: 'spam_days', label: 'Spam (days, at most 90)', kind: 'number' },
      ],
    },
  ],
  groups: [
    {
      id: 'region',
      title: 'Region and data',
      fields: ['timezone', 'retention'],
    },
  ],
};
