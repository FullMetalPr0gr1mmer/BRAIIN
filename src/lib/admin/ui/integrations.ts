import type { SingletonUi } from './types';

// Integrations: one row per tenant, the form at /admin/integrations.
export const integrationsUi: SingletonUi = {
  endpoint: '/api/admin/integrations',
  title: 'Integrations',
  fields: [
    {
      name: 'ga4',
      label: 'GA4 (JSON)',
      kind: 'json',
      help: 'Secondary analytics; consent-gated.',
    },
    {
      name: 'searchConsole',
      label: 'Search Console (JSON)',
      kind: 'json',
      column: 'search_console',
    },
    { name: 'calendly', label: 'Calendly (JSON)', kind: 'json' },
    { name: 'recaptcha', label: 'reCAPTCHA (JSON)', kind: 'json' },
  ],
};
