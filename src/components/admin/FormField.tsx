import type { TiptapDoc } from '@schemas/tiptap';
import type { FieldDef } from '@/lib/admin/uiSchema';
import RichText from './RichText';
import RelationField from './fields/RelationField';
import MediaField from './fields/MediaField';
import RepeaterField, { type RenderField } from './fields/RepeaterField';
import ClipField from './fields/ClipField';
import SectionContentField from './fields/SectionContentField';
import UploadField from './fields/UploadField';

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
  /** The whole form's values — a `sectionContent` field reads its sibling `type`. */
  values?: Row;
  /** Keeps element ids unique when the same field renders inside repeater items. */
  idPrefix?: string;
}

/** Renders a nested field (repeater items, section content) with the same renderer. */
const renderField: RenderField = (field, value, onChange, idPrefix) => (
  <Field key={field.name} field={field} value={value} onChange={onChange} idPrefix={idPrefix} />
);

export function Field({ field, value, onChange, values = {}, idPrefix = 'f' }: FieldProps) {
  const id = `${idPrefix}-${field.name}`;

  // ── composite and referencing kinds (UI v2) ──────────────────────────────────
  if (field.kind === 'relation' || field.kind === 'multiRelation') {
    return <RelationField field={field} value={value} onChange={onChange} />;
  }
  if (field.kind === 'media') {
    return <MediaField field={field} value={value} onChange={onChange} />;
  }
  if (field.kind === 'repeater') {
    return (
      <RepeaterField
        field={field}
        value={value}
        onChange={onChange}
        renderField={renderField}
        idPrefix={idPrefix}
      />
    );
  }
  if (field.kind === 'clip') {
    return <ClipField field={field} value={value} onChange={onChange} idPrefix={idPrefix} />;
  }
  if (field.kind === 'sectionContent') {
    return (
      <SectionContentField
        field={field}
        value={value}
        sectionType={values[field.typeField ?? 'type']}
        onChange={onChange}
        renderField={renderField}
        idPrefix={idPrefix}
      />
    );
  }
  if (field.kind === 'upload') {
    return <UploadField field={field} value={value} onChange={onChange} idPrefix={idPrefix} />;
  }
  if (field.kind === 'multiSelect') {
    const chosen = Array.isArray(value) ? (value as string[]) : [];
    return (
      <fieldset className="field-group">
        <legend className="field-legend">
          {field.label}
          {field.required ? ' *' : ''}
        </legend>
        <div className="row-3">
          {field.options?.map((option) => (
            <label key={option.value} className="field field-inline">
              <input
                type="checkbox"
                checked={chosen.includes(option.value)}
                onChange={(e) =>
                  onChange(
                    field.name,
                    e.target.checked
                      ? [...chosen, option.value]
                      : chosen.filter((v) => v !== option.value),
                  )
                }
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
        {field.help && <p className="admin-sub">{field.help}</p>}
      </fieldset>
    );
  }

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

// Pure payload shaping lives in src/lib/admin/formPayload.ts (unit-tested without a DOM);
// re-exported here because the forms import it from their field module.
export { rowToForm, formToPayload } from '@/lib/admin/formPayload';
