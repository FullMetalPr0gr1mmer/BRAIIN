import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CUSTOM_FIELD_CONTROL,
  CustomFieldDefinitionSchema,
  MAX_CUSTOM_NUMBER,
  MAX_CUSTOM_TEXT,
  type ContactCustom,
  type CustomFieldDefinition,
} from '@schemas/crm';
import type { AuthContext } from '@/lib/auth/types';
import { ValidationError } from '@/lib/admin/errors';

// A contact's custom field values, checked against the fields the CRM settings define (Admin
// v2 C6, crm.md §5.1; the definitions since C9b, crm_settings.custom_fields). The database
// checks each new or changed value again (app.tg_crm_contact_custom, the C9b migration) and
// bounds the whole object (< 8 KB); this is the Worker's half, which says what is wrong in
// words a person can act on.

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The tenant's custom field definitions, read as the caller (RLS: lead workers and
 * crm.settings holders read crm_settings; every crm.contacts holder works leads). A field that
 * does not parse is left out (the database's CHECK keeps none). Throws when the row cannot be
 * read: a value is never accepted or refused against definitions nobody read.
 */
export async function readCustomFields(
  sb: SupabaseClient,
  auth: AuthContext,
): Promise<CustomFieldDefinition[]> {
  const { data, error } = await sb
    .from('crm_settings')
    .select('custom_fields')
    .eq('tenant_id', auth.tenantId)
    .maybeSingle<{ custom_fields: unknown }>();
  if (error) throw new Error(`crm_settings custom_fields: ${error.message}`);
  return parseCustomFields(data?.custom_fields);
}

/** The definitions from whatever the row holds: the valid fields, each key once, in order. */
export function parseCustomFields(raw: unknown): CustomFieldDefinition[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.flatMap((item) => {
    const parsed = CustomFieldDefinitionSchema.safeParse(item);
    if (!parsed.success || seen.has(parsed.data.key)) return [];
    seen.add(parsed.data.key);
    return [parsed.data];
  });
}

/**
 * A real calendar day written YYYY-MM-DD (what a date input sends). Year 0000 is not one:
 * JavaScript reads it, PostgreSQL refuses it (app.crm_custom_date_ok), C9B-COR-4.
 */
export function isCustomDate(value: string): boolean {
  if (!DATE.test(value) || value.startsWith('0000')) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** Throws a ValidationError naming the first value that does not fit its field. */
export function validateCustomValues(
  definitions: readonly CustomFieldDefinition[],
  values: ContactCustom,
): ContactCustom {
  const byKey = new Map(definitions.map((d) => [d.key, d]));
  for (const [key, value] of Object.entries(values)) {
    const field = byKey.get(key);
    if (!field) throw new ValidationError(`There is no custom field called ${key}.`, 'custom');
    if (value === null) continue;
    const bad = (why: string) => new ValidationError(`${field.label}: ${why}`, 'custom');
    switch (field.type) {
      case 'text':
        if (typeof value !== 'string') throw bad('enter text.');
        if (value.length > MAX_CUSTOM_TEXT) throw bad('that is too long.');
        if (CUSTOM_FIELD_CONTROL.test(value)) throw bad('keep it to one line.');
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) throw bad('enter a number.');
        if (Math.abs(value) > MAX_CUSTOM_NUMBER) throw bad('that number is too large.');
        break;
      case 'date':
        if (typeof value !== 'string' || !isCustomDate(value)) throw bad('enter a date.');
        break;
    }
  }
  return values;
}

/**
 * What a contact's `custom` becomes: the stored values with the keys sent set, a null or an
 * empty text clearing one (it is removed, never stored as empty), the rest kept as they are.
 * A new contact starts from nothing.
 */
export function mergeCustom(stored: unknown, sent: ContactCustom): Record<string, unknown> {
  const out: Record<string, unknown> =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? { ...(stored as Record<string, unknown>) }
      : {};
  for (const [key, value] of Object.entries(sent)) {
    if (value === null || (typeof value === 'string' && value.trim() === '')) delete out[key];
    else out[key] = typeof value === 'string' ? value.trim() : value;
  }
  return out;
}
