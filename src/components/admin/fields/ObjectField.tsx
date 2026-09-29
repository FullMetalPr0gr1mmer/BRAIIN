import type { FieldDef } from '@/lib/admin/uiSchema';
import type { RenderField } from './RepeaterField';

// A fixed-shape object — the Services proof band's rating line ({value, label}) — edited
// with `itemFields`, like ONE repeater item without add / remove / move (Round 3). The
// payload shaping (formPayload.ts) omits the key altogether while every sub-field is
// blank, so an untouched editor never sends a half-empty object the schema would reject.

type Item = Record<string, unknown>;

interface Props {
  field: FieldDef;
  value: unknown;
  onChange: (name: string, value: unknown) => void;
  renderField: RenderField;
  idPrefix: string;
}

export default function ObjectField({ field, value, onChange, renderField, idPrefix }: Props) {
  const item = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Item;
  const itemFields = field.itemFields ?? [];
  const setItem = (name: string, v: unknown) => onChange(field.name, { ...item, [name]: v });

  return (
    <fieldset className="field-group">
      <legend className="field-legend">
        {field.label}
        {field.required ? ' *' : ''}
      </legend>
      {itemFields.map((sub) =>
        renderField(sub, item[sub.name], setItem, `${idPrefix}-${field.name}`),
      )}
      {field.help && <p className="admin-sub">{field.help}</p>}
    </fieldset>
  );
}
