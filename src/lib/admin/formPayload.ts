import { columnOf, type FieldDef } from '@/lib/admin/uiSchema';

// Form state <-> API payload for the admin ResourceForm / SingletonForm. Kept apart from
// the React field components so it can be unit-tested in node — a regression here does
// not fail loudly, it makes a form impossible to save (tests/lib/formPayload.spec.ts).

type Row = Record<string, unknown>;

/** API row (snake_case) → form state (camelCase), limited to declared fields. */
export function rowToForm(row: Row, fields: readonly FieldDef[]): Row {
  const out: Row = {};
  for (const field of fields) {
    const raw = row[columnOf(field)];
    if (field.kind === 'json') {
      out[field.name] = JSON.stringify(raw ?? {}, null, 2);
      continue;
    }
    if (field.kind === 'datetime' && typeof raw === 'string') {
      // <input type="datetime-local"> wants `YYYY-MM-DDTHH:mm`, no zone suffix.
      out[field.name] = raw.slice(0, 16);
      continue;
    }
    out[field.name] = raw ?? null;
  }
  return out;
}

/** Form state → API payload. Throws on malformed JSON so the field can be blamed. */
export function formToPayload(values: Row, fields: readonly FieldDef[]): Row {
  const out: Row = {};
  for (const field of fields) {
    const value = values[field.name];
    if (value === undefined) continue;

    if (field.kind === 'json') {
      // Rejected here rather than posted: the server would answer 400 "body must be
      // valid JSON" for the WHOLE request, which points at the wrong thing — the
      // request was fine, one textarea was not.
      try {
        out[field.name] = typeof value === 'string' ? JSON.parse(value || '{}') : (value ?? {});
      } catch {
        throw new Error(`${field.label} is not valid JSON.`);
      }
      continue;
    }

    if (field.kind === 'datetime') {
      out[field.name] = value ? new Date(String(value)).toISOString() : null;
      continue;
    }

    // An unset <select> means "leave it alone", not "set it to empty".
    if (field.kind === 'select' && !value) continue;

    // A NULLABLE bilingual pair left entirely blank means "none" (site_profile's legal
    // name), not `{en:'', ar:''}` — which the server would reject for being half-present.
    // Opt-in: every other bilingual field keeps sending its object, because most of those
    // columns are NOT NULL (seo_defaults' title template, for one) and a null would make
    // a blank save fail. A HALF-filled pair is still sent as-is so the server can say
    // which language is missing.
    if (
      (field.kind === 'bilingual' || field.kind === 'prose') &&
      field.nullable === true &&
      typeof value === 'object' &&
      value !== null &&
      Object.values(value as Record<string, unknown>).every(
        (v) => typeof v !== 'string' || v.trim() === '',
      )
    ) {
      out[field.name] = null;
      continue;
    }

    if (typeof value === 'string' && value.trim() === '') {
      out[field.name] = field.required ? '' : null;
      continue;
    }

    // `redirects.status` is the one numeric <select>; option values are always strings.
    out[field.name] =
      field.kind === 'select' && /^\d+$/.test(String(value)) ? Number(value) : value;
  }
  return out;
}
