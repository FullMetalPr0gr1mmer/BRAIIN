import { FormSettingsWriteSchema } from '@schemas/forms';
import type { SingletonConfig } from '@/lib/admin/singleton';
import { fieldsOf } from '@/lib/admin/resources/shared';

// The forms config (Admin v2 E8, `public.form_settings`, the E8 migration): what the inquiry
// form and the Join form change from the built-in forms. §5 "General settings": Admin +
// Developer (`settings.general`), which also publishes it once releases are on (P-2); staged
// like the identity (P-3), so with releases on the singleton kernel stages a save and with
// releases off it writes live, as every staged editor does today.
//
// A save names one form or both; each one it names replaces that form's stored differences
// whole (the editor always sends the whole form it shows). `consent_revision` is never
// written here: the database counts it (app.tg_form_consent_revision).

/** Payload key → column: what `toRow` copies, and (through `fieldsOf`) its `fields`. */
const FORM_SETTINGS_KEYS = {
  inquiry: 'inquiry',
  application: 'application',
};

export const formSettingsSingleton: SingletonConfig = {
  table: 'form_settings',
  entity: 'form_settings',
  readCaps: ['settings.general'],
  readAccess: ['full'],
  writeCap: 'settings.general',
  columns: 'tenant_id,inquiry,application,consent_revision,version,updated_at',
  schema: FormSettingsWriteSchema,
  defaults: { inquiry: {}, application: {}, consent_revision: 0 },
  toRow: (input) => {
    const out: Record<string, unknown> = {};
    for (const [key, column] of Object.entries(FORM_SETTINGS_KEYS)) {
      if (input[key] !== undefined) out[column] = input[key];
    }
    return out;
  },
  fields: fieldsOf(FORM_SETTINGS_KEYS),
  // The copy CHECKs (the E8 migration): a string with markup or a line break that got past
  // the schema, or a form over 16 KB, is a 422 on its form.
  constraintFields: {
    form_settings_inquiry_copy: {
      field: 'inquiry',
      message: 'Use plain words only, without < or > or line breaks.',
    },
    form_settings_application_copy: {
      field: 'application',
      message: 'Use plain words only, without < or > or line breaks.',
    },
  },
};
