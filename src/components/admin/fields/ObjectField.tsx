import type { ReactNode } from 'react';
import type { FieldErrors } from '@/lib/admin/fieldErrors';
import type { FieldDef } from '@/lib/admin/uiSchema';
import { FieldErrorText, describedBy } from './FieldShell';
import type { RenderField } from './RepeaterField';

// A fixed-shape object — the Services proof band's rating line ({value, label}) — edited
// with `itemFields`, like ONE repeater item without add / remove / move (Round 3). The
// payload shaping (formPayload.ts) omits the key altogether while every sub-field is
// blank, so an untouched editor never sends a half-empty object the schema would reject.
// Admin v2 E3: with `itemGroups` the sub-fields are drawn in titled groups (a fieldset each,
// inside this one), every sub-field still reading the whole object as its siblings.

type Item = Record<string, unknown>;

/** The sub-fields in their titled groups, then any sub-field no group names (Admin v2 E3). */
function ObjectGroups({
  groups,
  itemFields,
  draw,
  idPrefix,
}: {
  groups: NonNullable<FieldDef['itemGroups']>;
  itemFields: readonly FieldDef[];
  draw: (sub: FieldDef) => ReactNode;
  idPrefix: string;
}) {
  const byName = new Map(itemFields.map((sub) => [sub.name, sub]));
  const grouped = new Set(groups.flatMap((group) => group.fields));
  return (
    <>
      {groups.map((group) => {
        const subs = group.fields.flatMap((name) => byName.get(name) ?? []);
        if (subs.length === 0) return null;
        return (
          <fieldset
            key={group.id}
            id={`${idPrefix}-g-${group.id}`}
            className="field-group"
            data-group={group.id}
          >
            <legend className="field-legend">{group.title}</legend>
            {subs.map(draw)}
          </fieldset>
        );
      })}
      {itemFields.filter((sub) => !grouped.has(sub.name)).map(draw)}
    </>
  );
}

interface Props {
  field: FieldDef;
  value: unknown;
  onChange: (name: string, value: unknown) => void;
  renderField: RenderField;
  idPrefix: string;
  errors?: FieldErrors | undefined;
}

export default function ObjectField({
  field,
  value,
  onChange,
  renderField,
  idPrefix,
  errors,
}: Props) {
  const id = `${idPrefix}-${field.name}`;
  const error = errors?.[id];
  const item = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Item;
  const itemFields = field.itemFields ?? [];
  const setItem = (name: string, v: unknown) => onChange(field.name, { ...item, [name]: v });

  return (
    // The group carries the id (focusable by script only), so an error that names the whole
    // object links here (fieldErrors.ts).
    <fieldset
      id={id}
      tabIndex={-1}
      className="field-group"
      aria-describedby={describedBy(id, { error })}
    >
      <legend className="field-legend">
        {field.label}
        {field.required ? ' *' : ''}
      </legend>
      {field.itemGroups ? (
        <ObjectGroups
          groups={field.itemGroups}
          itemFields={itemFields}
          draw={(sub) => renderField(sub, item[sub.name], setItem, id, { values: item })}
          idPrefix={id}
        />
      ) : (
        itemFields.map((sub) => renderField(sub, item[sub.name], setItem, id, { values: item }))
      )}
      {field.help && <p className="admin-sub">{field.help}</p>}
      <FieldErrorText id={id} message={error} />
    </fieldset>
  );
}
