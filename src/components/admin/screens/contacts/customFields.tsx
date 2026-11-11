import type { ContactCustom, CustomFieldDefinition } from '@schemas/crm';

// The custom fields a contact carries (Admin v2 C9b, crm.md §11 screens 6 and 7): drawn under
// Details on a contact's page and in Add contact, from the definitions CRM settings keep
// (crm_settings.custom_fields). Every value is a string while it is being typed; what is sent
// is a number for a number field, YYYY-MM-DD for a date (the date input's own form), trimmed
// text, or null to clear a field. The server checks each value against its field again, and
// the database once more (app.tg_crm_contact_custom).

/** A field's values as the form holds them: the field's key → what is in its box. */
export type CustomFormValues = Record<string, string>;

/** The limits the schema and the database hold (packages/schemas/crm.ts; the C9b migration). */
export const CUSTOM_LIMITS = { maxText: 500, maxNumber: 1e15 } as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The boxes' starting values from what a contact holds (nothing for a new contact). */
export function customFormValues(
  fields: readonly CustomFieldDefinition[],
  stored: unknown,
): CustomFormValues {
  const custom =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const out: CustomFormValues = {};
  for (const field of fields) {
    const value = custom[field.key];
    out[field.key] = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  }
  return out;
}

/** What one box sends: null when empty, else the field's type. */
function sendable(field: CustomFieldDefinition, raw: string): string | number | null {
  const text = raw.trim();
  if (text === '') return null;
  return field.type === 'number' ? Number(text) : text;
}

/**
 * The `custom` part of a request: every field whose box changed from `before` (all filled ones
 * for a new contact, whose `before` is empty), or null when nothing changed. A cleared box is
 * sent as null, which the server takes as "remove this value".
 */
export function customPatch(
  fields: readonly CustomFieldDefinition[],
  before: CustomFormValues,
  after: CustomFormValues,
): ContactCustom | null {
  const patch: ContactCustom = {};
  for (const field of fields) {
    const was = (before[field.key] ?? '').trim();
    const now = (after[field.key] ?? '').trim();
    if (was === now) continue;
    patch[field.key] = sendable(field, now);
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** What the form refuses before it asks the server, by field key, in plain words (P-12). */
export function customErrors(
  fields: readonly CustomFieldDefinition[],
  values: CustomFormValues,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const text = (values[field.key] ?? '').trim();
    if (text === '') continue;
    if (field.type === 'number') {
      const n = Number(text);
      if (!Number.isFinite(n)) errors[field.key] = 'Enter a number.';
      else if (Math.abs(n) > CUSTOM_LIMITS.maxNumber)
        errors[field.key] = 'That number is too large.';
    } else if (field.type === 'date') {
      const time = Date.parse(`${text}T00:00:00Z`);
      if (
        !DATE.test(text) ||
        Number.isNaN(time) ||
        new Date(time).toISOString().slice(0, 10) !== text
      ) {
        errors[field.key] = 'Enter a date.';
      }
    } else if (text.length > CUSTOM_LIMITS.maxText) {
      errors[field.key] = `Keep it to ${CUSTOM_LIMITS.maxText} characters.`;
    } else if (CONTROL.test(text)) {
      errors[field.key] = 'Keep it to one line.';
    }
  }
  return errors;
}

interface InputsProps {
  fields: readonly CustomFieldDefinition[];
  values: CustomFormValues;
  /** The id prefix of the form: each box is `${idPrefix}-c-${key}`. */
  idPrefix: string;
  errors?: Readonly<Record<string, string>>;
  onChange: (key: string, value: string) => void;
}

/** One labelled box per field: a text box, a number box or a date picker. */
export function CustomFieldInputs({
  fields,
  values,
  idPrefix,
  errors = {},
  onChange,
}: InputsProps) {
  return (
    <>
      {fields.map((field) => {
        const id = `${idPrefix}-c-${field.key}`;
        const error = errors[field.key];
        return (
          <div className="f" key={field.key}>
            <label className="f__l" htmlFor={id}>
              {field.label}
            </label>
            <input
              id={id}
              type={field.type === 'text' ? 'text' : field.type}
              value={values[field.key] ?? ''}
              autoComplete="off"
              dir={field.type === 'text' ? 'auto' : 'ltr'}
              {...(field.type === 'text' ? { maxLength: CUSTOM_LIMITS.maxText } : {})}
              {...(field.type === 'number' ? { inputMode: 'decimal' as const, step: 'any' } : {})}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={(event) => onChange(field.key, event.target.value)}
            />
            {error && (
              <p id={`${id}-error`} className="field-error f__err">
                {error}
              </p>
            )}
          </div>
        );
      })}
    </>
  );
}
