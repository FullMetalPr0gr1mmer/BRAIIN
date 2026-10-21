import type { SingletonUi } from './types';

// Style-Finder results & logic: one row per tenant, the form at /admin/ai-config (Admin only,
// `ai.config`). Nothing reads `ai_config` yet: /api/ai/style-finder is the 501 stub, and its
// limits are the code's constants (AI_IP_LIMIT 60 and AI_SESSION_LIMIT 20 in
// src/lib/ai/rateLimit.ts, AI_DAILY_USD_CAP in src/lib/ai/spendCap.ts). The hints say so,
// and tests/lib/styleFinderUi.spec.ts holds their numbers to those constants and to
// AiConfigSchema's ceilings. Whoever wires the quiz takes the LOWER of a stored value and
// the code's ceiling, so an edit here can only tighten them (Pillar 1; as-built U8a).
export const aiConfigUi: SingletonUi = {
  endpoint: '/api/admin/ai-config',
  title: 'Style-Finder results & logic',
  fields: [
    {
      name: 'enabled',
      label: 'Quiz switched on',
      kind: 'checkbox',
      help: 'Not read yet: the quiz is not built.',
    },
    { name: 'model', label: 'Model', kind: 'text', maxLength: 80 },
    {
      name: 'dailyUsdCap',
      label: 'Daily spend cap (USD)',
      kind: 'number',
      column: 'daily_usd_cap',
      help: 'At most 1000. Not read yet.',
    },
    {
      name: 'perIpHourlyLimit',
      label: 'Requests an hour per address',
      kind: 'number',
      column: 'per_ip_hourly_limit',
      help: 'From 1 to 1000. Not read yet: today the limit is fixed at 60 an hour.',
    },
    {
      name: 'perSessionHourlyLimit',
      label: 'Requests an hour per visitor',
      kind: 'number',
      column: 'per_session_hourly_limit',
      help: 'From 1 to 1000. Not read yet: today the limit is fixed at 20 an hour.',
    },
    {
      name: 'systemPrompt',
      label: 'Instructions for the model',
      kind: 'textarea',
      column: 'system_prompt',
      maxLength: 8000,
    },
    {
      name: 'scoring',
      label: 'Scoring (advanced)',
      kind: 'json',
      help: 'JSON. Nothing reads it yet: the quiz is not built.',
    },
  ],
};
