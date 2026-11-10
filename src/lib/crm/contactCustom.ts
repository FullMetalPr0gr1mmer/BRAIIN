import type { ContactCustom, CustomFieldDefinition } from '@schemas/crm';
import { ValidationError } from '@/lib/admin/errors';

// A contact's custom field values, checked against the fields the CRM settings define
// (Admin v2 C6; crm.md §5.1). The definitions arrive with CRM settings v2 (C9b,
// crm_settings.custom_fields); until then there are none, so any custom value is an unknown
// field and is refused, and a contact's `custom` stays the empty object the database starts
// it with. The database bounds the whole object (< 8 KB, an object); this is the field-level
// half: a known key, the right type, within its bounds.

/** The tenant's custom field definitions. None until C9b adds them to crm_settings. */
export function customFieldDefinitions(): readonly CustomFieldDefinition[] {
  return [];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

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
        if (value.length > (field.maxLength ?? 500)) throw bad('that is too long.');
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) throw bad('enter a number.');
        if (field.min !== undefined && value < field.min) throw bad(`the least is ${field.min}.`);
        if (field.max !== undefined && value > field.max) throw bad(`the most is ${field.max}.`);
        break;
      case 'date':
        if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(value))) {
          throw bad('enter a date.');
        }
        break;
      case 'select':
        if (typeof value !== 'string' || !(field.options ?? []).includes(value)) {
          throw bad('choose one of the options.');
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') throw bad('choose yes or no.');
        break;
    }
  }
  return values;
}
