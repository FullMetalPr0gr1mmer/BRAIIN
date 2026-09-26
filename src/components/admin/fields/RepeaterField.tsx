import type { ReactNode } from 'react';
import type { FieldDef } from '@/lib/admin/uiSchema';

// An array of objects — columns of the "why us" block, a case study's result cards, a
// section's social links. Each item is edited with the same field renderer as a whole
// form (passed in, so this module does not import FormField and create a cycle).

type Item = Record<string, unknown>;
export type RenderField = (
  field: FieldDef,
  value: unknown,
  onChange: (name: string, value: unknown) => void,
  idPrefix: string,
) => ReactNode;

interface Props {
  field: FieldDef;
  value: unknown;
  onChange: (name: string, value: unknown) => void;
  renderField: RenderField;
  idPrefix: string;
}

export default function RepeaterField({ field, value, onChange, renderField, idPrefix }: Props) {
  const items = Array.isArray(value) ? (value as Item[]) : [];
  const itemFields = field.itemFields ?? [];
  const full = field.maxItems !== undefined && items.length >= field.maxItems;

  const setItems = (next: Item[]) => onChange(field.name, next);
  const setItem = (index: number, name: string, v: unknown) =>
    setItems(items.map((item, i) => (i === index ? { ...item, [name]: v } : item)));
  const move = (index: number, by: -1 | 1) => {
    const next = [...items];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item as Item);
    setItems(next);
  };

  return (
    <fieldset className="field-group">
      <legend className="field-legend">{field.label}</legend>
      {items.length === 0 && (
        <p className="admin-sub">None yet — the section's built-in copy shows.</p>
      )}
      {items.map((item, index) => (
        <fieldset key={index} className="repeater-item">
          <legend className="field-legend">
            {field.label} {index + 1}
          </legend>
          {itemFields.map((sub) =>
            renderField(
              sub,
              item[sub.name],
              (name, v) => setItem(index, name, v),
              `${idPrefix}-${field.name}-${index}`,
            ),
          )}
          <div className="toolbar">
            <button
              type="button"
              className="btn"
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              Move up
            </button>
            <button
              type="button"
              className="btn"
              disabled={index === items.length - 1}
              onClick={() => move(index, 1)}
            >
              Move down
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setItems(items.filter((_, i) => i !== index))}
            >
              Remove {field.label.toLowerCase()} {index + 1}
            </button>
          </div>
        </fieldset>
      ))}
      <button
        type="button"
        className="btn"
        disabled={full}
        onClick={() => setItems([...items, {}])}
      >
        {full ? `At most ${field.maxItems}` : `Add ${field.label.toLowerCase()}`}
      </button>
      {field.help && <p className="admin-sub">{field.help}</p>}
    </fieldset>
  );
}
