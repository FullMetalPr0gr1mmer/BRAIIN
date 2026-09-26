import type { FieldDef } from '@/lib/admin/uiSchema';
import { useOptions } from './useOptions';

// `relation` (one id) and `multiRelation` (an ORDERED list of ids). Order is data for a
// multi relation — "featured projects", a case study's services — so the list keeps the
// sequence the editor chose and offers up/down moves rather than a sorted checkbox grid.

interface Props {
  field: FieldDef;
  value: unknown;
  onChange: (name: string, value: unknown) => void;
}

export default function RelationField({ field, value, onChange }: Props) {
  const { options, error, loading } = useOptions(field.relation);
  const id = `f-${field.name}`;
  const labelFor = (v: string) => options.find((o) => o.value === v)?.label ?? v;

  if (field.kind === 'relation') {
    const current = typeof value === 'string' ? value : '';
    return (
      <label className="field" htmlFor={id}>
        <span>
          {field.label}
          {field.required ? ' *' : ''}
        </span>
        <select
          id={id}
          value={current}
          disabled={loading}
          onChange={(e) => onChange(field.name, e.target.value)}
        >
          <option value="">{loading ? 'Loading…' : '—'}</option>
          {/* a stored id the list does not contain (hidden, or beyond the page) stays selectable */}
          {current && !options.some((o) => o.value === current) && (
            <option value={current}>{current}</option>
          )}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {error && <span role="alert">{error}</span>}
        {field.help && <span>{field.help}</span>}
      </label>
    );
  }

  const selected = Array.isArray(value) ? (value as string[]) : [];
  const full = field.maxItems !== undefined && selected.length >= field.maxItems;
  const move = (index: number, by: -1 | 1) => {
    const next = [...selected];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item as string);
    onChange(field.name, next);
  };

  return (
    <fieldset className="field-group">
      <legend className="field-legend">
        {field.label}
        {field.required ? ' *' : ''}
      </legend>
      {selected.length > 0 && (
        <ol className="item-list">
          {selected.map((v, index) => (
            <li key={v} className="item-row">
              <span className="item-label">{labelFor(v)}</span>
              <button
                type="button"
                className="btn"
                disabled={index === 0}
                aria-label={`Move ${labelFor(v)} up`}
                onClick={() => move(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="btn"
                disabled={index === selected.length - 1}
                aria-label={`Move ${labelFor(v)} down`}
                onClick={() => move(index, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="btn"
                aria-label={`Remove ${labelFor(v)}`}
                onClick={() =>
                  onChange(
                    field.name,
                    selected.filter((s) => s !== v),
                  )
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ol>
      )}
      <label className="field" htmlFor={id}>
        <span>Add</span>
        <select
          id={id}
          value=""
          disabled={loading || full}
          onChange={(e) => {
            if (e.target.value) onChange(field.name, [...selected, e.target.value]);
          }}
        >
          <option value="">
            {loading ? 'Loading…' : full ? `At most ${field.maxItems}` : '—'}
          </option>
          {options
            .filter((o) => !selected.includes(o.value))
            .map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
        </select>
      </label>
      {error && (
        <p className="admin-sub" role="alert">
          {error}
        </p>
      )}
      {field.help && <p className="admin-sub">{field.help}</p>}
    </fieldset>
  );
}
