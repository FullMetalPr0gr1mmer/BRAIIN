import type { FieldDef, SingletonUi } from './types';

// Integrations (Admin v2 U11): one row per tenant, three typed public identifiers. Each is
// edited alone, in its tile's drawer on /admin/integrations (src/lib/admin/integrations/
// tiles.ts names the field each tile edits); the activity log names a saved column by the
// label here. Formats and refusals are packages/schemas/integrations.ts.

export const GA4_FIELD: FieldDef = {
  name: 'ga4MeasurementId',
  label: 'Google Analytics measurement ID',
  kind: 'text',
  column: 'ga4_measurement_id',
  help: 'It starts with G-. Google Analytics shows it under Admin, Data streams.',
};

export const SEARCH_CONSOLE_FIELD: FieldDef = {
  name: 'searchConsoleToken',
  label: 'Search Console verification code',
  kind: 'text',
  column: 'search_console_token',
  help: 'In Search Console choose the HTML tag method, then paste the whole tag or just the code inside content.',
};

export const CALENDLY_FIELD: FieldDef = {
  name: 'calendlyUrl',
  label: 'Calendly booking link',
  kind: 'url',
  column: 'calendly_url',
  maxLength: 200,
  help: 'Like https://calendly.com/your-name.',
};

export const integrationsUi: SingletonUi = {
  endpoint: '/api/admin/integrations',
  title: 'Integrations',
  fields: [GA4_FIELD, SEARCH_CONSOLE_FIELD, CALENDLY_FIELD],
};
