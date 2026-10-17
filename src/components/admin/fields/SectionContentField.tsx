import { useState } from 'react';
import {
  enterAdvanced,
  leaveAdvanced,
  objectToForm,
  shownSectionValues,
  type SectionContentState,
} from '@/lib/admin/formPayload';
import { accentGroups, sectionFields } from '@/lib/admin/sectionUi';
import type { FieldErrors } from '@/lib/admin/fieldErrors';
import type { FieldDef } from '@/lib/admin/uiSchema';
import { FieldErrorText, describedBy } from './FieldShell';
import type { RenderField } from './RepeaterField';

// `page_sections.content`, edited with the fields of the section's own type (SECTION_UI)
// instead of a raw JSON box — with "Advanced (JSON)" kept for anything the typed editor
// does not cover. The type lives in a sibling field, so a change of type re-renders
// this editor with the new type's fields.
//
// v2 (Admin v2 F5b, ui.md §2.6 "sectionContent"):
//
//   PREFILL. Given the section's built-in copy (the `builtIn` prop: what the page renders
//   with nothing stored, F6/AV-23), a field with nothing of its own SHOWS those words
//   instead of an empty box, so an editor starts from the page rather than from blank.
//   The contract of that prop: it is the built-in content of THIS section's look, with
//   the fields F6 marks `notVerbatim` left out — their built-in value is not what the
//   page renders from a stored one (it names the studio through `%brand%` or bolds a run),
//   so prefilling them would store something else than what is shown.
//
//   DIFFERENCES ONLY. Nothing is stored for a field left at its built-in value
//   (`omitBuiltIn` in formPayload.ts), so a later change to the built-in copy still
//   reaches every section that never overrode it. A key group the type reads together
//   (an accent and the heading it counts the words of) is stored whole or not at all.
//
//   RESET. One button puts every field back to the built-in copy; the save then stores
//   nothing for them.
//
//   ADVANCED (JSON) is offered to Admins only (`canAdvanced`, decision D5 — the UX half
//   of `content.archiveDelete`; the server validates every save either way). A section
//   that is ALREADY holding raw JSON (content left over from another type) still shows
//   it to everyone: hiding it would hide content nobody could then clear.

type Row = Record<string, unknown>;

interface Props {
  field: FieldDef;
  value: unknown;
  sectionType: unknown;
  onChange: (name: string, value: unknown) => void;
  renderField: RenderField;
  idPrefix: string;
  errors?: FieldErrors | undefined;
  /** The section's built-in copy, in content shape (see the header's contract). */
  builtIn?: unknown;
  /** "Advanced (JSON)" is offered (Admin, D5). */
  canAdvanced?: boolean | undefined;
}

const asRow = (value: unknown): Row | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : undefined;

export default function SectionContentField({
  field,
  value,
  sectionType,
  onChange,
  renderField,
  idPrefix,
  errors,
  builtIn,
  canAdvanced = false,
}: Props) {
  const state = (value ?? { values: {}, json: null }) as SectionContentState;
  const typed = sectionFields(sectionType);
  const id = `${idPrefix}-${field.name}`;
  const error = errors?.[id];
  const [jsonError, setJsonError] = useState<string | null>(null);

  const builtInRow = asRow(builtIn);
  const together = typed ? accentGroups(typed) : [];
  // The built-in copy travels WITH the state, so the payload can drop what equals it
  // (formPayload's omitBuiltIn) — written on the first change, never on a render, so a
  // form nobody has touched is not marked dirty by it.
  const carry = builtInRow ? { builtIn: builtInRow, together } : {};
  const set = (patch: Partial<SectionContentState>) =>
    onChange(field.name, { ...state, ...carry, ...patch });

  // Switching modes never loses work: entering carries the typed values (and the stored
  // keys the fields do not cover) into the JSON; leaving parses the JSON back — or, when
  // it does not parse, stays in Advanced mode and says so.
  const toggleAdvanced = (on: boolean) => {
    if (on) {
      setJsonError(null);
      onChange(field.name, enterAdvanced({ ...state, ...carry }, sectionType));
      return;
    }
    try {
      onChange(field.name, leaveAdvanced({ ...state, ...carry }, sectionType));
      setJsonError(null);
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : String(err));
    }
  };

  // No type chosen yet, or a type whose data lives in its own table.
  if (!typed && state.json === null) {
    return (
      <div
        id={id}
        tabIndex={-1}
        className="field-group"
        aria-describedby={describedBy(id, { error })}
      >
        <p className="field-legend">{field.label}</p>
        <p className="admin-sub">
          {sectionType
            ? 'This section takes its content from its own table (team, certifications…), so there is nothing to override here.'
            : 'Choose a section type to edit its content.'}
        </p>
        <FieldErrorText id={id} message={error} />
      </div>
    );
  }

  const advanced = state.json !== null;
  const fields = typed ?? [];
  // What the editor SEES: each field's own words once it has some, else the built-in copy
  // (formPayload's shownSectionValues, which the save sends too). The fields are drawn
  // from it AND read their siblings from it, so an accent counts the heading on screen,
  // not the empty box behind a prefilled one (F5b review M4).
  const shown = shownSectionValues(state.values, fields, builtInRow);

  return (
    <fieldset
      id={id}
      tabIndex={-1}
      className="field-group"
      aria-describedby={describedBy(id, { error })}
    >
      <legend className="field-legend">{field.label}</legend>
      {canAdvanced && typed && (
        <label className="field field-inline" htmlFor={`${id}-advanced`}>
          <input
            id={`${id}-advanced`}
            type="checkbox"
            checked={advanced}
            onChange={(e) => toggleAdvanced(e.target.checked)}
          />
          <span>Advanced (JSON)</span>
        </label>
      )}
      {advanced ? (
        <label className="field" htmlFor={`${id}-json`}>
          <span>Content JSON</span>
          <textarea
            id={`${id}-json`}
            spellCheck={false}
            value={state.json ?? ''}
            aria-describedby={jsonError ? `${id}-json-error` : undefined}
            aria-invalid={jsonError ? true : undefined}
            onChange={(e) => set({ json: e.target.value })}
          />
          {jsonError && (
            <span id={`${id}-json-error`} className="field-error" role="alert">
              {jsonError}
            </span>
          )}
          <span>
            Validated against the section type on save. Keys you leave out use the built-in copy.
          </span>
        </label>
      ) : (
        fields.map((sub) =>
          renderField(
            sub,
            shown.values[sub.name],
            (name, v) => set({ values: { ...state.values, [name]: v } }),
            id,
            {
              values: shown.values,
              ...(builtInRow && sub.name in builtInRow ? { builtIn: builtInRow[sub.name] } : {}),
              // (an accent's built-in is read from its parent's keys, above)
            },
          ),
        )
      )}
      {!advanced && (
        <div className="sectionf__foot">
          <p className="admin-sub">
            {builtInRow
              ? 'Every field starts as the words the page already shows. Change one to make it yours; leave it and the built-in copy stays, even when it is improved later.'
              : 'Every field is optional. Leave one empty to keep the built-in copy.'}
          </p>
          {builtInRow && shown.own.size > 0 && (
            <button
              type="button"
              data-variant="ghost"
              onClick={() => set({ values: objectToForm({}, fields) })}
            >
              Reset to the built-in copy
            </button>
          )}
        </div>
      )}
      <FieldErrorText id={id} message={error} />
    </fieldset>
  );
}
