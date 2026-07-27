import type { TiptapDoc } from '@schemas/tiptap';
import { columnOf, type FieldDef } from '@/lib/admin/uiSchema';
import RichText from './RichText';

// One renderer per field kind, shared by ResourceForm and SingletonForm.
//
// Shared on purpose. The two forms have different save paths (collection vs singleton),
// but if they each rendered their own inputs, "bilingual" would eventually mean two
// inputs in one and one input in the other — and the half that lost its Arabic field
// would keep passing every test, because the server accepts a partial PATCH.

export type Row = Record<string, unknown>;

export interface FieldProps {
  field: FieldDef;
  value: unknown;
  onChange: (name: string, value: unknown) => void;
}

export function Field({ field, value, onChange }: FieldProps) {
  const id = `f-${field.name}`;

  if (field.kind === 'bilingual' || field.kind === 'prose') {
    const record = (value ?? {}) as Record<string, string>;
    const multiline = field.kind === 'prose';
    return (
      <fieldset className="field-group">
        <legend className="field-legend">
          {field.label}
          {field.required ? ' *' : ''}
        </legend>
        <div className="row-2">
          <label className="field">
            <span>English</span>
            {multiline ? (
              <textarea
                id={`${id}-en`}
                lang="en"
                value={record['en'] ?? ''}
                onChange={(e) => onChange(field.name, { ...record, en: e.target.value })}
              />
            ) : (
              <input
                id={`${id}-en`}
                type="text"
                lang="en"
                value={record['en'] ?? ''}
                onChange={(e) => onChange(field.name, { ...record, en: e.target.value })}
              />
            )}
          </label>
          <label className="field">
            {/* AR is starred for `bilingual` because indexable metadata must be
                bilingual from day one (Pillar 3); `prose` lets AR lag translation. */}
            <span>العربية{field.kind === 'bilingual' ? ' *' : ''}</span>
            {multiline ? (
              <textarea
                id={`${id}-ar`}
                lang="ar"
                dir="rtl"
                value={record['ar'] ?? ''}
                onChange={(e) => onChange(field.name, { ...record, ar: e.target.value })}
              />
            ) : (
              <input
                id={`${id}-ar`}
                type="text"
                lang="ar"
                dir="rtl"
                value={record['ar'] ?? ''}
                onChange={(e) => onChange(field.name, { ...record, ar: e.target.value })}
              />
            )}
          </label>
        </div>
        {field.help && <p className="admin-sub">{field.help}</p>}
      </fieldset>
    );
  }

  if (field.kind === 'richtext') {
    const doc = (value ?? {}) as Record<string, TiptapDoc | undefined>;
    return (
      <div className="field-group">
        <p className="field-legend">{field.label} — English</p>
        <RichText
          label={`${field.label} English`}
          locale="en"
          value={doc['en'] ?? null}
          onChange={(next) => onChange(field.name, { ...doc, en: next })}
        />
        <p className="field-legend">{field.label} — العربية</p>
        <RichText
          label={`${field.label} Arabic`}
          locale="ar"
          value={doc['ar'] ?? null}
          onChange={(next) => onChange(field.name, { ...doc, ar: next })}
        />
      </div>
    );
  }

  if (field.kind === 'select') {
    return (
      <label className="field" htmlFor={id}>
        <span>{field.label}</span>
        <select
          id={id}
          value={String(value ?? '')}
          onChange={(e) => onChange(field.name, e.target.value)}
        >
          <option value="">—</option>
          {field.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {field.help && <span>{field.help}</span>}
      </label>
    );
  }

  if (field.kind === 'checkbox') {
    return (
      <label className="field field-inline" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(field.name, e.target.checked)}
        />
        <span>{field.label}</span>
      </label>
    );
  }

  if (field.kind === 'json' || field.kind === 'textarea') {
    const text =
      field.kind === 'textarea'
        ? value === null || value === undefined
          ? ''
          : String(value)
        : typeof value === 'string'
          ? value
          : JSON.stringify(value ?? {}, null, 2);
    return (
      <label className="field" htmlFor={id}>
        <span>{field.label}</span>
        <textarea
          id={id}
          value={text}
          onChange={(e) => onChange(field.name, e.target.value)}
          spellCheck={field.kind === 'textarea'}
        />
        {field.help && <span>{field.help}</span>}
      </label>
    );
  }

  if (field.kind === 'tags') {
    const tags = Array.isArray(value) ? (value as string[]) : [];
    return (
      <label className="field" htmlFor={id}>
        <span>{field.label}</span>
        <input
          id={id}
          type="text"
          value={tags.join(', ')}
          onChange={(e) =>
            onChange(
              field.name,
              e.target.value
                .split(',')
                .map((tag) => tag.trim())
                .filter(Boolean),
            )
          }
        />
        <span>Comma-separated.</span>
      </label>
    );
  }

  const inputType =
    field.kind === 'number'
      ? 'number'
      : field.kind === 'url'
        ? 'url'
        : field.kind === 'datetime'
          ? 'datetime-local'
          : 'text';

  return (
    <label className="field" htmlFor={id}>
      <span>
        {field.label}
        {field.required ? ' *' : ''}
      </span>
      <input
        id={id}
        type={inputType}
        value={value === null || value === undefined ? '' : String(value)}
        onChange={(e) =>
          onChange(
            field.name,
            field.kind === 'number' ? numberOrNull(e.target.value) : e.target.value,
          )
        }
      />
      {field.help && <span>{field.help}</span>}
    </label>
  );
}

function numberOrNull(raw: string): number | null {
  if (raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

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
