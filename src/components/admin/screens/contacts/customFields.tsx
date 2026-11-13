import type { ContactCustom, CustomFieldDefinition } from '@schemas/crm';

// The custom fields a contact carries (Admin v2 C9b, crm.md §11 screens 6 and 7): drawn under
// Details on a contact's page and in Add contact, from the definitions CRM settings keep
// (crm_settings.custom_fields). Every value is a string while it is being typed; what is sent
// is a number for a number field, YYYY-MM-DD for a date (the date input's own form), trimmed
// text, or null to clear a field. The server checks each value against its field again, and
// the database once more (app.tg_crm_contact_custom).
//
// A number is typed in a text box (inputMode decimal), never type=number: a number box the
// browser cannot read ("1-2", "1e") reports its value as '' and the form took that for a
// cleared box, sending null and deleting what was stored (C9b review, C9B-COR-2). A date keeps
// the browser's date picker, which does the same for a partly typed date, so the form asks the
// box itself (validity.badInput, unreadableBoxes) before it saves and refuses while it is set.

/** A field's values as the form holds them: the field's key → what is in its box. */
export type CustomFormValues = Record<string, string>;

/** The limits the schema and the database hold (packages/schemas/crm.ts; the C9b migration). */
export const CUSTOM_LIMITS = { maxText: 500, maxNumber: 1e15 } as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A number as a person types it: an optional sign, digits with an optional point, an exponent. */
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
/** What a text value may not hold: the schema's CUSTOM_FIELD_CONTROL (a test holds them equal). */
export const CUSTOM_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** A real calendar day written YYYY-MM-DD, as the Worker's isCustomDate (year 0000 is not one). */
export function isDateText(text: string): boolean {
  if (!DATE.test(text) || text.startsWith('0000')) return false;
  const time = Date.parse(`${text}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === text;
}

/** The part of a box the form asks about: whether the browser could read what is in it. */
interface Readable {
  validity?: { badInput?: boolean };
}

/**
 * The keys of the boxes holding something the browser could not read (a partly typed date):
 * such a box reports '' like an empty one, so it is asked, never its value. `find` is
 * `document.getElementById` in the screens (an element that is not an input has no
 * `validity`, so it reads as readable).
 */
export function unreadableBoxes(
  fields: readonly CustomFieldDefinition[],
  idPrefix: string,
  find: (id: string) => object | null,
): Set<string> {
  const out = new Set<string>();
  for (const field of fields) {
    const box = find(`${idPrefix}-c-${field.key}`) as Readable | null;
    if (box?.validity?.badInput) out.add(field.key);
  }
  return out;
}

const NONE: ReadonlySet<string> = new Set();

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

/**
 * What the form refuses before it asks the server, by field key, in plain words (P-12).
 * `unreadable` names the boxes the browser could not read (unreadableBoxes): each is refused,
 * so the save never sends null for a value nobody cleared.
 */
export function customErrors(
  fields: readonly CustomFieldDefinition[],
  values: CustomFormValues,
  unreadable: ReadonlySet<string> = NONE,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    if (unreadable.has(field.key)) {
      errors[field.key] = field.type === 'date' ? 'Enter a date.' : 'Enter a number.';
      continue;
    }
    const text = (values[field.key] ?? '').trim();
    if (text === '') continue;
    if (field.type === 'number') {
      const n = Number(text);
      if (!NUMBER.test(text) || !Number.isFinite(n)) errors[field.key] = 'Enter a number.';
      else if (Math.abs(n) > CUSTOM_LIMITS.maxNumber)
        errors[field.key] = 'That number is too large.';
    } else if (field.type === 'date') {
      if (!isDateText(text)) errors[field.key] = 'Enter a date.';
    } else if (text.length > CUSTOM_LIMITS.maxText) {
      errors[field.key] = `Keep it to ${CUSTOM_LIMITS.maxText} characters.`;
    } else if (CUSTOM_CONTROL.test(text)) {
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

/** One labelled box per field: a text box (for a number too, see above) or a date picker. */
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
              type={field.type === 'date' ? 'date' : 'text'}
              value={values[field.key] ?? ''}
              autoComplete="off"
              dir={field.type === 'text' ? 'auto' : 'ltr'}
              {...(field.type === 'text' ? { maxLength: CUSTOM_LIMITS.maxText } : {})}
              {...(field.type === 'number' ? { inputMode: 'decimal' as const } : {})}
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
