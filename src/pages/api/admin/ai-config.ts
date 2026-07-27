import { AiConfigSchema } from '@schemas/admin';
import { singletonRoutes } from '@/lib/admin/singleton';

// AI Style-Finder results/logic config — ADMIN ONLY (`ai.config`), unlike the questions
// and styles editors which Content Creator also holds (`ai.editContent`). Separate
// table for that reason; see migration 0009.
//
// Note what is NOT here: the model API key. That is an `astro:env` secret held as a
// Cloudflare Worker Secret and never reaches a database column an admin UI can display
// (CLAUDE.md Pillar 1). This row configures the envelope — cap, limits, prompt — around
// a key the CMS cannot read.

export const prerender = false;

export const { GET, PATCH } = singletonRoutes({
  table: 'ai_config',
  entity: 'ai_config',
  readCaps: ['ai.config'],
  readAccess: ['full'],
  writeCap: 'ai.config',
  columns:
    'tenant_id,enabled,model,daily_usd_cap,per_ip_hourly_limit,per_session_hourly_limit,system_prompt,scoring,version,updated_at',
  schema: AiConfigSchema,
  defaults: {
    enabled: false,
    model: 'claude-sonnet-5',
    daily_usd_cap: 5,
    per_ip_hourly_limit: 60,
    per_session_hourly_limit: 20,
    scoring: {},
  },
  toRow: (input) => {
    const out: Record<string, unknown> = {};
    if (input['enabled'] !== undefined) out['enabled'] = input['enabled'];
    if (input['model'] !== undefined) out['model'] = input['model'];
    if (input['dailyUsdCap'] !== undefined) out['daily_usd_cap'] = input['dailyUsdCap'];
    if (input['perIpHourlyLimit'] !== undefined) {
      out['per_ip_hourly_limit'] = input['perIpHourlyLimit'];
    }
    if (input['perSessionHourlyLimit'] !== undefined) {
      out['per_session_hourly_limit'] = input['perSessionHourlyLimit'];
    }
    if (input['systemPrompt'] !== undefined) out['system_prompt'] = input['systemPrompt'];
    if (input['scoring'] !== undefined) out['scoring'] = input['scoring'];
    return out;
  },
});
