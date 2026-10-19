import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { constraintOf } from '@/lib/admin/crud';
import { InUseError, OptimisticLockError, ValidationError } from '@/lib/admin/errors';
import { AuthorizationError } from '@/lib/authz/errors';
import type { CrmSettingsSave, LeadStagesSave } from '@schemas/crm';

// CRM settings for leads (Admin v2 C9a, crm.md CRM-9): what the screen reads and the two
// writes, shared by the routes (src/pages/api/admin/crm/settings.ts, stages.ts). Every read
// and write goes through the caller's client, so RLS, the live check and the column grants
// decide (0091); the Worker's crm.settings check is the second layer.

export const SETTINGS_COLUMNS =
  'version,scoring,sla_hours,timezone,assignment_rule,assignment_pool,assignment_fixed_to,updated_at';
export const STAGE_COLUMNS = 'id,key,label,label_ar,tone,kind,is_initial,sort_order,version';

export interface CrmSettingsView {
  version: number;
  scoring: Record<string, number>;
  slaHours: number;
  timezone: string;
  assignment: { rule: string; pool: string[]; fixedTo: string | null };
  updatedAt: string | null;
}

export interface StageView {
  id: string;
  key: string;
  label: string;
  label_ar: string | null;
  tone: string;
  kind: string;
  is_initial: boolean;
  sort_order: number;
  version: number;
  /** How many leads sit in it, spam included (they keep their stage). */
  leads: number;
}

export interface PersonView {
  id: string;
  display_name: string | null;
  role: string | null;
}

/** The row as the screen reads it. Unknown keys are dropped. */
export function settingsView(row: Record<string, unknown>): CrmSettingsView {
  const pool = Array.isArray(row['assignment_pool'])
    ? (row['assignment_pool'] as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  const scoring =
    row['scoring'] && typeof row['scoring'] === 'object' && !Array.isArray(row['scoring'])
      ? Object.fromEntries(
          Object.entries(row['scoring'] as Record<string, unknown>).filter(
            (e): e is [string, number] => typeof e[1] === 'number',
          ),
        )
      : {};
  return {
    version: Number(row['version'] ?? 1),
    scoring,
    slaHours: Number(row['sla_hours'] ?? 24),
    timezone: String(row['timezone'] ?? 'Asia/Riyadh'),
    assignment: {
      rule: String(row['assignment_rule'] ?? 'manual'),
      pool,
      fixedTo: typeof row['assignment_fixed_to'] === 'string' ? row['assignment_fixed_to'] : null,
    },
    updatedAt: typeof row['updated_at'] === 'string' ? row['updated_at'] : null,
  };
}

/** The stages in board order, each with how many leads it holds. */
export function stagesView(
  rows: readonly Record<string, unknown>[],
  counts: readonly Record<string, unknown>[],
): StageView[] {
  const byStage = new Map(counts.map((c) => [String(c['stage_id']), Number(c['leads'] ?? 0)]));
  return rows.map((row) => ({
    id: String(row['id']),
    key: String(row['key']),
    label: String(row['label']),
    label_ar: typeof row['label_ar'] === 'string' ? row['label_ar'] : null,
    tone: String(row['tone']),
    kind: String(row['kind']),
    is_initial: row['is_initial'] === true,
    sort_order: Number(row['sort_order'] ?? 0),
    version: Number(row['version'] ?? 1),
    leads: byStage.get(String(row['id'])) ?? 0,
  }));
}

/** Everything the screen draws: the settings, the pipeline with its counts, the people. */
export async function readCrmSettings(
  sb: SupabaseClient,
  auth: AuthContext,
): Promise<{ settings: CrmSettingsView; stages: StageView[]; people: PersonView[] }> {
  const [settings, stages, counts, people] = await Promise.all([
    sb.from('crm_settings').select(SETTINGS_COLUMNS).eq('tenant_id', auth.tenantId).maybeSingle(),
    sb
      .from('lead_stages')
      .select(STAGE_COLUMNS)
      .eq('tenant_id', auth.tenantId)
      .order('sort_order', { ascending: true }),
    sb.rpc('lead_stage_counts', { p_tenant: auth.tenantId }),
    sb.rpc('crm_people', { p_tenant: auth.tenantId }),
  ]);
  if (settings.error) throw new Error(`crm_settings: ${settings.error.message}`);
  if (stages.error) throw new Error(`lead_stages: ${stages.error.message}`);
  if (counts.error) throw new Error(`lead_stage_counts: ${counts.error.message}`);
  if (people.error) throw new Error(`crm_people: ${people.error.message}`);
  if (!settings.data) throw new Error('crm_settings: the tenant has no row');
  const rows = (data: unknown) => (Array.isArray(data) ? (data as Record<string, unknown>[]) : []);
  return {
    settings: settingsView(settings.data as Record<string, unknown>),
    stages: stagesView(rows(stages.data), rows(counts.data)),
    people: rows(people.data).map((p) => ({
      id: String(p['id']),
      display_name: typeof p['display_name'] === 'string' ? p['display_name'] : null,
      role: typeof p['role'] === 'string' ? p['role'] : null,
    })),
  };
}

/** The columns a save writes, and the field names its audit row records (never values). */
export function settingsPatch(input: CrmSettingsSave): {
  values: Record<string, unknown>;
  fields: string[];
} {
  const values: Record<string, unknown> = {};
  const fields: string[] = [];
  if (input.scoring) {
    values['scoring'] = input.scoring;
    fields.push('lead_scoring');
  }
  if (input.slaHours !== undefined) {
    values['sla_hours'] = input.slaHours;
    fields.push('response_time');
  }
  if (input.assignment) {
    values['assignment_rule'] = input.assignment.rule;
    values['assignment_pool'] = input.assignment.pool;
    values['assignment_fixed_to'] = input.assignment.fixedTo;
    fields.push('assignment');
  }
  return { values, fields };
}

/** The constraints 0091's assignee check names, and the field each belongs to. */
const ASSIGNMENT_CONSTRAINTS: Record<string, { field: string; detail: string }> = {
  crm_settings_assignment_pool: {
    field: 'pool',
    detail: 'Everyone in the rotation must be an active member who works leads.',
  },
  crm_settings_assignment_fixed_to: {
    field: 'fixedTo',
    detail: 'Choose an active member who works leads.',
  },
  crm_settings_fixed_to_fk: {
    field: 'fixedTo',
    detail: 'Choose an active member who works leads.',
  },
};

/** One card's save, at the version the screen read: the new settings, or a mapped refusal. */
export async function saveCrmSettings(
  sb: SupabaseClient,
  auth: AuthContext,
  input: CrmSettingsSave,
): Promise<CrmSettingsView> {
  const { values } = settingsPatch(input);
  const { data, error } = await sb
    .from('crm_settings')
    .update(values)
    .eq('tenant_id', auth.tenantId)
    .eq('version', input.version)
    .select(SETTINGS_COLUMNS)
    .maybeSingle();
  if (error) {
    if (error.code === '23514' || error.code === '23503') {
      const known = ASSIGNMENT_CONSTRAINTS[constraintOf(error) ?? ''];
      if (known) throw new ValidationError(known.detail, known.field);
      throw new ValidationError('Those settings are not allowed.');
    }
    throw new Error(`crm_settings update: ${error.message}`);
  }
  // No row: the version moved on (someone else saved). A caller who may not write it was
  // refused before this, by the route's crm.settings check and the session check.
  if (!data) throw new OptimisticLockError('crm_settings');
  return settingsView(data as Record<string, unknown>);
}

/** What a stage refusal says to the person who saved. */
const STAGES_REFUSED =
  'That pipeline is not allowed: it needs 2 to 10 stages, at least one Won and one Lost, with the first stage kept first.';

function inUseDetail(details: unknown): string {
  try {
    const parsed = JSON.parse(String(details)) as Record<string, unknown>;
    const label = typeof parsed['label'] === 'string' ? parsed['label'] : 'A stage';
    const n = Number(parsed['leads'] ?? 0);
    const leads = n === 1 ? '1 lead' : `${n} leads`;
    return parsed['change'] === 'kind'
      ? `${label} holds ${leads}, so it keeps its kind. Move its ${leads} first.`
      : `${label} holds ${leads}. Move its ${leads} first.`;
  } catch {
    return 'A stage you removed still holds leads. Move them first.';
  }
}

/** The whole pipeline, through public.save_lead_stages (0091), as the caller. */
export async function saveLeadStages(
  sb: SupabaseClient,
  auth: AuthContext,
  input: LeadStagesSave,
): Promise<{ stages: Record<string, unknown>[]; added: number; removed: number }> {
  const { data, error } = await sb.rpc('save_lead_stages', {
    p_tenant: auth.tenantId,
    p_known: input.known,
    p_stages: input.stages,
  });
  if (error) {
    switch (error.code) {
      case '40001':
        throw new OptimisticLockError('lead_stages');
      // The door checks the caller's live role and tenant itself (a refused write through
      // RLS would change nothing and say nothing).
      case '42501':
        throw new AuthorizationError('crm.settings', 'refused by the database');
      // 23503 is the door's own refusal; 23001 (restrict_violation) is what PostgreSQL 17
      // raises if the foreign key itself refuses a delete.
      case '23503':
      case '23001':
        throw new InUseError(inUseDetail(error.details));
      case '22023':
      case '23514':
        throw new ValidationError(STAGES_REFUSED, 'stages');
      default:
        throw new Error(`save_lead_stages: ${error.message}`);
    }
  }
  const kept = new Set(input.stages.flatMap((s) => (s.id ? [s.id] : [])));
  return {
    stages: Array.isArray(data) ? (data as Record<string, unknown>[]) : [],
    added: input.stages.filter((s) => !s.id).length,
    removed: input.known.filter((k) => !kept.has(k.id)).length,
  };
}
