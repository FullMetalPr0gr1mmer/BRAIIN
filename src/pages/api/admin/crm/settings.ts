import { defineAdminRoute } from '@/lib/admin/route';
import { readCrmSettings, saveCrmSettings, settingsPatch } from '@/lib/crm/settings';
import { CrmSettingsSaveSchema } from '@schemas/crm';

// CRM settings for leads (Admin v2 C9a): `crm.settings`, Admin only (CLAUDE.md §5).
//   GET  the settings, the pipeline with how many leads each stage holds, and the people a
//        lead can be given to (four reads, as the caller: RLS and the live check decide).
//   PUT  one card's change (the points, the response time or the assignment) at the version
//        the screen read; 409 when someone saved first. New points re-score every lead in the
//        same statement (0091). Audited `crm.settings.update` with the fields' names only.
// The pipeline itself is saved through PUT /api/admin/crm/stages.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'crm.settings',
  handler: async ({ auth, sb }) => readCrmSettings(sb, auth),
});

export const PUT = defineAdminRoute({
  cap: 'crm.settings',
  input: CrmSettingsSaveSchema,
  handler: async ({ auth, sb, input, audit }) => {
    const settings = await saveCrmSettings(sb, auth, input);
    audit({
      action: 'crm.settings.update',
      entityType: 'crm_settings',
      entityId: auth.tenantId,
      detail: { fields: settingsPatch(input).fields, version: settings.version },
    });
    return { settings };
  },
});
