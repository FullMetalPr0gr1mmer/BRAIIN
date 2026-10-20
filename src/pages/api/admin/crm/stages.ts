import { defineAdminRoute } from '@/lib/admin/route';
import { saveLeadStages, STAGE_COLUMNS } from '@/lib/crm/settings';
import { LeadStagesSaveSchema } from '@schemas/crm';

// The pipeline's stages.
//   GET  in board order (Admin v2 C2a): `leads.manage`. Configuration, not personal data; RLS
//        returns the caller's tenant's stages to lead workers only.
//   PUT  the whole pipeline (Admin v2 C9a): `crm.settings`, Admin only. Through
//        public.save_lead_stages (0091, as the caller), against the stages as the screen
//        loaded them: 409 when someone saved first, or when a stage that holds leads would be
//        removed or change kind ("Move its N leads first"). Audited `crm.stages.update` with
//        counts only.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'leads.manage',
  handler: async ({ auth, sb }) => {
    const { data, error } = await sb
      .from('lead_stages')
      .select(STAGE_COLUMNS)
      .eq('tenant_id', auth.tenantId)
      .order('sort_order', { ascending: true });
    if (error) throw new Error(`lead stages: ${error.message}`);
    return { stages: data ?? [] };
  },
});

export const PUT = defineAdminRoute({
  cap: 'crm.settings',
  input: LeadStagesSaveSchema,
  handler: async ({ auth, sb, input, audit }) => {
    const saved = await saveLeadStages(sb, auth, input);
    audit({
      action: 'crm.stages.update',
      entityType: 'lead_stages',
      entityId: auth.tenantId,
      detail: { stages: input.stages.length, added: saved.added, removed: saved.removed },
    });
    return { stages: saved.stages };
  },
});
