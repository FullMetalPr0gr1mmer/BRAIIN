import { defineAdminRoute } from '@/lib/admin/route';
import { can } from '@/lib/authz/matrix';
import { readCustomFields } from '@/lib/crm/contactCustom';
import {
  customFieldsChange,
  readCrmSettings,
  saveCrmSettings,
  settingsPatch,
} from '@/lib/crm/settings';
import { CrmSettingsSaveSchema } from '@schemas/crm';

// CRM settings (Admin v2 C9a, C9b): `crm.settings`, Admin only (CLAUDE.md §5).
//   GET  the settings (the custom contact fields among them, C9b), the pipeline with how many
//        leads each stage holds, the people a lead can be given to, and what the Data & privacy
//        card states (the retention horizon; whether the viewer may erase a person or change
//        the horizon: UX flags, the routes they lead to check again). Five reads, as the
//        caller: RLS and the live check decide.
//   PUT  one card's change (the points, the response time, the assignment, or the custom
//        fields) at the version the screen read; 409 when someone saved first. New points
//        re-score every lead in the same statement (0091); a removed custom field takes every
//        contact's value in it (C9b). Audited `crm.settings.update` with the fields' names and,
//        for the custom fields, counts only: never a label, a key or a value.
// The pipeline itself is saved through PUT /api/admin/crm/stages.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'crm.settings',
  handler: async ({ auth, sb }) => {
    const { retentionMonths, ...read } = await readCrmSettings(sb, auth);
    return {
      ...read,
      privacy: {
        retentionMonths,
        canErase: can(auth.role, 'crm.erase') === 'full',
        canEditRetention: can(auth.role, 'settings.general') === 'full',
      },
    };
  },
});

export const PUT = defineAdminRoute({
  cap: 'crm.settings',
  input: CrmSettingsSaveSchema,
  handler: async ({ auth, sb, input, audit }) => {
    // The set as it stands, for the audit row's counts (only when the fields are saved).
    const before = input.customFields ? await readCustomFields(sb, auth) : null;
    const settings = await saveCrmSettings(sb, auth, input);
    audit({
      action: 'crm.settings.update',
      entityType: 'crm_settings',
      entityId: auth.tenantId,
      detail: {
        fields: settingsPatch(input).fields,
        version: settings.version,
        ...(before ? { customFields: customFieldsChange(before, settings.customFields) } : {}),
      },
    });
    return { settings };
  },
});
