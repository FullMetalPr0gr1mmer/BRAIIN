import { useRef, useState, type ReactNode } from 'react';
import Icon from '@/components/admin/kit/Icon';
import { MoveButtons, SortHandle, SortHint } from '@/components/admin/kit/Sortable';
import { useSortable } from '@/components/admin/kit/useSortable';
import type { FieldErrors } from '@/lib/admin/fieldErrors';
import type { FieldDef } from '@/lib/admin/uiSchema';
import { useRevealListener } from './reveal';

// An array of objects — columns of the "why us" block, a case study's result cards, a
// section's social links. Each item is edited with the same field renderer as a whole
// form (passed in, so this module does not import FormField and create a cycle).
//
// v2 (Admin v2 F5a, ui.md §2.6, the prototype's .repeat): each item is a card headed by
// its name ("Value we add 2") and a title computed from its own text, with the kit's
// Sortable handle ("Reorder <title>": drag it, or Space, the arrows and Space), Move up /
// Move down (always there: a drag is never the only way, WCAG 2.5.7), a collapse toggle for
// long items, and "Remove <label> N". Add is disabled at the most the schema takes, and
// says so ("At most 6"). Element ids stay `<prefix>-<name>-<index>-<sub>`: the index is the
// item's place, the same path the API's errors name (fieldErrors.ts). A reveal request for
// an input in a collapsed item opens it (reveal.ts).

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
  errors?: FieldErrors | undefined;
}

/** The first words an item holds, for its card's title and its handle's name. */
export function itemTitle(item: Item, fields: readonly FieldDef[]): string {
  for (const sub of fields) {
    const raw = item[sub.name];
    const text =
      typeof raw === 'string'
        ? raw
        : raw && typeof raw === 'object' && typeof (raw as Item)['en'] === 'string'
          ? ((raw as Item)['en'] as string)
          : '';
    if (sub.kind !== 'json' && text.trim() !== '') return text.trim().slice(0, 60);
  }
  return '';
}

export default function RepeaterField({
  field,
  value,
  onChange,
  renderField,
  idPrefix,
  errors,
}: Props) {
  const items = Array.isArray(value) ? (value as Item[]) : [];
  const itemFields = field.itemFields ?? [];
  const max = field.maxItems;
  const full = max !== undefined && items.length >= max;
  const base = `${idPrefix}-${field.name}`;

  // Each item's key for React and the Sortable core, kept in step with the list by every
  // change made here; a list that grows or shrinks from outside (a load) is keyed again.
  // Deterministic, so the server's markup and the first client render agree, and prefixed
  // with this field's id, so a repeater inside an item never shares a key with its parent
  // (the Sortable core finds items by key anywhere under its list).
  const added = useRef(0);
  const keys = useRef<string[]>([]);
  if (keys.current.length !== items.length) {
    keys.current = items.map((_, i) => `${base}:${i}`);
  }
  const newKey = () => `${base}:n${++added.current}`;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const commit = (next: Item[], nextKeys: string[]) => {
    keys.current = nextKeys;
    onChange(field.name, next);
  };
  const setItem = (index: number, name: string, v: unknown) =>
    onChange(
      field.name,
      items.map((item, i) => (i === index ? { ...item, [name]: v } : item)),
    );

  const { ref, lists, hintId } = useSortable<HTMLOListElement>({
    lists: { list: keys.current },
    onCommit: (next) => {
      const order = next['list'] ?? [];
      const byKey = new Map(keys.current.map((k, i) => [k, items[i] as Item]));
      commit(
        order.map((k) => byKey.get(k) ?? {}),
        [...order],
      );
    },
  });

  // An error link or a "Next gap" naming an input in a collapsed item opens that item.
  useRevealListener((id) => {
    keys.current.forEach((key, index) => {
      if (collapsed.has(key) && id.startsWith(`${base}-${index}-`)) {
        setCollapsed((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    });
  });

  const nameOf = (index: number) => `${field.label} ${index + 1}`;
  const count = max !== undefined ? `${items.length} of ${max}` : `${items.length}`;
  const order = lists['list'] ?? keys.current;
  const groupError = errors?.[base];

  return (
    <fieldset id={base} tabIndex={-1} className="f f--group">
      <legend className="field-legend">{field.label}</legend>
      <div className="f__bar">
        <span className="f__meta">{count === '1' ? '1 item' : `${count} items`}</span>
      </div>
      {items.length === 0 && <p className="admin-sub">None yet.</p>}
      <ol className="repeat__list" ref={ref} aria-label={field.label}>
        {order.map((key) => {
          const index = keys.current.indexOf(key);
          const item = items[index];
          if (!item || index === -1) return null;
          const title = itemTitle(item, itemFields);
          const name = nameOf(index);
          // The item's own words name it while it moves ("Brief lifted, position 1 of 3"):
          // its number changes with its place, its title does not.
          const sortName = title || name;
          const shut = collapsed.has(key);
          const headId = `${base}-${index}--head`;
          const bodyId = `${base}-${index}--body`;
          return (
            <li
              key={key}
              className="repeat__i"
              data-sortable-id={key}
              data-sortable-label={sortName}
            >
              <div className="repeat__h">
                <SortHandle label={sortName} describedBy={hintId} />
                <span className="repeat__n" id={headId}>
                  {name}
                </span>
                {title && <span className="repeat__t">{title}</span>}
                <MoveButtons label={sortName} />
                <button
                  type="button"
                  className="icon-btn"
                  aria-expanded={!shut}
                  aria-controls={bodyId}
                  aria-label={`${shut ? 'Expand' : 'Collapse'} ${sortName}`}
                  onClick={() =>
                    setCollapsed((current) => {
                      const next = new Set(current);
                      if (shut) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                >
                  <Icon name="chevd" size={14} className={shut ? undefined : 'ic--flip'} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  data-variant="danger"
                  aria-label={`Remove ${field.label.toLowerCase()} ${index + 1}`}
                  onClick={() =>
                    commit(
                      items.filter((_, i) => i !== index),
                      keys.current.filter((_, i) => i !== index),
                    )
                  }
                >
                  <Icon name="trash" size={15} />
                </button>
              </div>
              <div
                className="repeat__b"
                id={bodyId}
                role="group"
                aria-labelledby={headId}
                hidden={shut}
              >
                {itemFields.map((sub) =>
                  renderField(
                    sub,
                    item[sub.name],
                    (n, v) => setItem(index, n, v),
                    `${base}-${index}`,
                  ),
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <SortHint id={hintId} />
      <button
        type="button"
        className="repeat__add"
        data-variant="soft"
        disabled={full}
        onClick={() => commit([...items, {}], [...keys.current, newKey()])}
      >
        <Icon name="plus" size={14} />
        {full ? `At most ${max}` : `Add ${field.label.toLowerCase()}`}
      </button>
      {groupError && (
        <p id={`${base}-error`} className="field-error f__err">
          {groupError}
        </p>
      )}
      {field.help && <p className="f__hint">{field.help}</p>}
    </fieldset>
  );
}
