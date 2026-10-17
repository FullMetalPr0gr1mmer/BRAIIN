import { useState } from 'react';
import FieldShell, { describedBy } from './FieldShell';
import { useOptions } from './useOptions';
import type { FieldComponentProps } from './types';

// `slugRelation` (Admin v2 F5b, ui.md §2.6): an ORDERED pick of other rows, stored by
// SLUG rather than by id — the shape a few section-content keys take, because the public
// renderer looks those rows up by slug (`selectedWork.cardSlugs`).
//
// The options come from the related resource's own admin API (useOptions, with
// `relation.valueKey: 'slug'`), so the list is exactly the rows the caller's role may
// read — never a client-side guess. Order is data here (the cards are shown in the order
// chosen), so the list keeps the editor's sequence and offers Move up / Move down rather
// than a sorted grid of checkboxes.
//
// A slug the picker does not offer (a project since unpublished, or one beyond the first
// page) stays in the list and keeps its place: removing it has to be a decision, not a
// side effect of loading the form.

export default function SlugRelationField({
  field,
  value,
  onChange,
  idPrefix,
  errors,
}: FieldComponentProps) {
  const { options, error: loadError, loading } = useOptions(field.relation);
  const [pick, setPick] = useState('');
  const id = `${idPrefix}-${field.name}`;
  const addId = `${id}-add`;
  const error = errors?.[id];
  const chosen = Array.isArray(value) ? (value as string[]).map(String) : [];
  const max = field.maxItems;
  const full = max !== undefined && chosen.length >= max;
  const nameOf = (slug: string) => options.find((option) => option.value === slug)?.label ?? slug;

  const move = (index: number, by: -1 | 1) => {
    const next = [...chosen];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item as string);
    onChange(field.name, next);
  };

  return (
    <FieldShell
      as="fieldset"
      id={id}
      label={field.label}
      required={field.required}
      meta={max === undefined ? undefined : `${chosen.length} of ${max}`}
      hint={field.help}
      error={error}
    >
      {chosen.length === 0 ? (
        <p className="f__cue">None chosen yet.</p>
      ) : (
        <ol className="item-list">
          {chosen.map((slug, index) => (
            <li key={slug} className="item-row">
              <span className="item-label">{nameOf(slug)}</span>
              {/* The slug only when it says something the name does not: with no options
                  loaded yet the name IS the slug, and saying it twice is noise. */}
              {nameOf(slug) !== slug && <span className="item-slug">{slug}</span>}
              <button
                type="button"
                className="btn"
                disabled={index === 0}
                aria-label={`Move ${nameOf(slug)} up`}
                onClick={() => move(index, -1)}
              >
                Up
              </button>
              <button
                type="button"
                className="btn"
                disabled={index === chosen.length - 1}
                aria-label={`Move ${nameOf(slug)} down`}
                onClick={() => move(index, 1)}
              >
                Down
              </button>
              <button
                type="button"
                className="btn"
                aria-label={`Remove ${nameOf(slug)}`}
                onClick={() =>
                  onChange(
                    field.name,
                    chosen.filter((item) => item !== slug),
                  )
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ol>
      )}
      {/* A value control plus an explicit button: arrow keys on a closed select fire
          `change` in Windows browsers, so "add on change" would add every option the
          keyboard passed over (WCAG F37) — the same rule as RelationField. */}
      <div className="item-row">
        <label className="field" htmlFor={addId}>
          <span>Add to {field.label}</span>
          <select
            id={addId}
            value={pick}
            disabled={loading || full}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy(id, { hint: field.help, error })}
            onChange={(e) => setPick(e.target.value)}
          >
            {/* "At most N" comes first: once the list is full, nothing can be added
                whether the options have arrived or not. */}
            <option value="">{full ? `At most ${max}` : loading ? 'Loading…' : 'Not set'}</option>
            {options
              .filter((option) => !chosen.includes(option.value))
              .map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
          </select>
        </label>
        <button
          type="button"
          className="btn"
          disabled={!pick || full}
          onClick={() => {
            onChange(field.name, [...chosen, pick]);
            setPick('');
          }}
        >
          Add
        </button>
      </div>
      {loadError && (
        <p className="field-error f__err" role="alert">
          {loadError}
        </p>
      )}
    </FieldShell>
  );
}
