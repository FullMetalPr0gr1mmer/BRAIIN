import type { SingletonUi } from './types';

// Style-Finder results & logic: one row per tenant, the form at /admin/ai-config.
export const aiConfigUi: SingletonUi = {
  endpoint: '/api/admin/ai-config',
  title: 'Style-Finder results & logic',
  fields: [
    { name: 'enabled', label: 'Enabled', kind: 'checkbox' },
    { name: 'model', label: 'Model', kind: 'text' },
    {
      name: 'dailyUsdCap',
      label: 'Daily spend cap (USD)',
      kind: 'number',
      column: 'daily_usd_cap',
      help: 'The hard ceiling. Capped at 1000 by the schema so a stray zero cannot lift it.',
    },
    {
      name: 'perIpHourlyLimit',
      label: 'Per-IP hourly limit',
      kind: 'number',
      column: 'per_ip_hourly_limit',
    },
    {
      name: 'perSessionHourlyLimit',
      label: 'Per-session hourly limit',
      kind: 'number',
      column: 'per_session_hourly_limit',
    },
    { name: 'systemPrompt', label: 'System prompt', kind: 'textarea', column: 'system_prompt' },
    { name: 'scoring', label: 'Scoring (JSON)', kind: 'json' },
  ],
};
