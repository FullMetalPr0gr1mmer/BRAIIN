import { useState } from 'react';
import { enterAdvanced, leaveAdvanced, type SectionContentState } from '@/lib/admin/formPayload';
import { sectionFields } from '@/lib/admin/sectionUi';
import type { FieldDef } from '@/lib/admin/uiSchema';
import type { RenderField } from './RepeaterField';

// `page_sections.content`, edited with the fields of the section's own type (SECTION_UI)
// instead of a raw JSON box — with "Advanced (JSON)" kept for anything the typed editor
// does not cover. The type lives in a sibling field, so a change of type re-renders
// this editor with the new type's fields.

interface Props {
  field: FieldDef;
  value: unknown;
  sectionType: unknown;
  onChange: (name: string, value: unknown) => void;
  renderField: RenderField;
  idPrefix: string;
}

export default function SectionContentField({
  field,
  value,
  sectionType,
  onChange,
  renderField,
  idPrefix,
}: Props) {
  const state = (value ?? { values: {}, json: null }) as SectionContentState;
  const typed = sectionFields(sectionType);
  const id = `${idPrefix}-${field.name}`;
  const [jsonError, setJsonError] = useState<string | null>(null);
  const set = (patch: Partial<SectionContentState>) => onChange(field.name, { ...state, ...patch });

  // Switching modes never loses work: entering carries the typed values (and the stored
  // keys the fields do not cover) into the JSON; leaving parses the JSON back — or, when
  // it does not parse, stays in Advanced mode and says so.
  const toggleAdvanced = (on: boolean) => {
    if (on) {
      setJsonError(null);
      onChange(field.name, enterAdvanced(state, sectionType));
      return;
    }
    try {
      onChange(field.name, leaveAdvanced(state, sectionType));
      setJsonError(null);
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : String(err));
    }
  };

  // No type chosen yet, or a type whose data lives in its own table.
  if (!typed && state.json === null) {
    return (
      <div className="field-group">
        <p className="field-legend">{field.label}</p>
        <p className="admin-sub">
          {sectionType
            ? 'This section takes its content from its own table (statistics, team, certifications…) — there is nothing to override here.'
            : 'Choose a section type to edit its content.'}
        </p>
      </div>
    );
  }

  const advanced = state.json !== null;
  return (
    <fieldset className="field-group">
      <legend className="field-legend">{field.label}</legend>
      <label className="field field-inline" htmlFor={`${id}-advanced`}>
        <input
          id={`${id}-advanced`}
          type="checkbox"
          checked={advanced}
          disabled={!typed}
          onChange={(e) => toggleAdvanced(e.target.checked)}
        />
        <span>Advanced (JSON)</span>
      </label>
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
        (typed ?? []).map((sub) =>
          renderField(
            sub,
            state.values[sub.name],
            (name, v) => set({ values: { ...state.values, [name]: v } }),
            id,
          ),
        )
      )}
      {!advanced && (
        <p className="admin-sub">
          Every field is optional — leave one empty to keep the built-in copy.
        </p>
      )}
    </fieldset>
  );
}
