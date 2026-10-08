import type { SingletonUi } from './types';

// General settings: one row per tenant, the form at /admin/settings.
export const settingsUi: SingletonUi = {
  endpoint: '/api/admin/settings',
  title: 'General settings',
  fields: [
    {
      name: 'identity',
      label: 'Technical identity keys (JSON)',
      kind: 'json',
      help: 'Server-side keys only (e.g. notify_lead_url). The public brand, contact details and socials live in “Public identity” above.',
    },
    {
      name: 'retention',
      label: 'Retention horizons (JSON)',
      kind: 'json',
      help: 'raw_telemetry_days is capped at 90 — the PDPL promise may be shortened, never extended.',
    },
  ],
};
