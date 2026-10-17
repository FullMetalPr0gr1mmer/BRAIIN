import { useState } from 'react';
import {
  enterAdvanced,
  leaveAdvanced,
  objectToForm,
  objectToPayload,
  type SectionContentState,
} from '@/lib/admin/formPayload';
import { accentGroups, contentKeysOf, sectionFields } from '@/lib/admin/sectionUi';
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
            ? 'This section takes its content from its own table (team, certifications…) — there is nothing to override here.'
            : 'Choose a section type to edit its content.'}
        </p>
        <FieldErrorText id={id} message={error} />
      </div>
    );
  }

  const advanced = state.json !== null;
  const fields = typed ?? [];
  // The built-in copy in FORM shape, and which fields the editor has written something of
  // their own into: computed with every sibling present, so an accent is judged against
  // the heading it counts.
  const builtInForm = builtInRow ? objectToForm(builtInRow, fields) : undefined;
  const written = objectToPayload(state.values, fields);
  const hasBuiltIn = (sub: FieldDef): boolean =>
    // By the KEYS a field writes, not its name: an accent stored as two numbers has no
    // key of its own (AccentDef mode 'from'), and would never be prefilled otherwise.
    builtInRow !== undefined && contentKeysOf(sub).some((key) => key in builtInRow);
  const shownValue = (sub: FieldDef): unknown => {
    const own = state.values[sub.name];
    if (!builtInForm || !hasBuiltIn(sub)) return own;
    return contentKeysOf(sub).some((key) => key in written) ? own : builtInForm[sub.name];
  };

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
            shownValue(sub),
            (name, v) => set({ values: { ...state.values, [name]: v } }),
            id,
            {
              values: state.values,
              ...(builtInRow && sub.name in builtInRow ? { builtIn: builtInRow[sub.name] } : {}),
              // (an accent's built-in is read from its parent's keys, above)
            },
          ),
        )
      )}
      {!advanced && (
        <div className="sectionf__foot">
          <p className="admin-sub">
            {builtInForm
              ? 'Every field starts as the words the page already shows. Change one to make it yours; leave it and the built-in copy stays, even when it is improved later.'
              : 'Every field is optional — leave one empty to keep the built-in copy.'}
          </p>
          {builtInForm && Object.keys(written).length > 0 && (
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
