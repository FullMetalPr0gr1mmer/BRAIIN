import FieldShell, { describedBy } from './FieldShell';
import type { FieldComponentProps } from './types';

// `checkbox` as a switch (Admin v2 F5a, ui.md §2.6, the prototype's .tog): a real button
// with role="switch" and aria-checked, named by its visible label, so Space and Enter
// toggle it natively and a click on the label does too (a <label for> a button forwards
// the click). The track and the knob are admin.css's `button[role='switch']` rules, drawn
// from the ARIA state: no style attribute, no class to keep in step.

export default function SwitchField({
  field,
  value,
  onChange,
  idPrefix,
  errors,
}: FieldComponentProps) {
  const id = `${idPrefix}-${field.name}`;
  const error = errors?.[id];
  const on = value === true;
  return (
    <FieldShell
      id={id}
      label={field.label}
      required={field.required}
      hint={field.help}
      error={error}
      inline
    >
      <button
        type="button"
        role="switch"
        id={id}
        aria-checked={on}
        aria-labelledby={`${id}-label`}
        aria-describedby={describedBy(id, { hint: field.help, error })}
        aria-invalid={error ? true : undefined}
        onClick={() => onChange(field.name, !on)}
      />
    </FieldShell>
  );
}
