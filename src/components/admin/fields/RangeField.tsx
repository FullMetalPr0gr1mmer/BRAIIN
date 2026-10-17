import { clampToRange, clampToStep } from '@/lib/admin/fieldValues';
import FieldShell, { describedBy } from './FieldShell';
import type { FieldComponentProps } from './types';

export { clampToStep };

// `range` (Admin v2 F5a, ui.md §2.6, the prototype's .range): a slider over `field.range`
// (min, max, step) with its value read out beside it in an <output for>, plus the suffix
// ("6000 ms"). Nothing stored shows the default (or the minimum) and says it is not set,
// so an untouched slider saves nothing (formPayload.ts omits it inside section content).

export default function RangeField({
  field,
  value,
  onChange,
  idPrefix,
  errors,
}: FieldComponentProps) {
  const id = `${idPrefix}-${field.name}`;
  const error = errors?.[id];
  const range = field.range ?? { min: 0, max: 100, step: 1 };
  const set = typeof value === 'number' && Number.isFinite(value);
  const fallback = typeof field.defaultValue === 'number' ? field.defaultValue : range.min;
  // Read out as stored (held to the bounds only): a stored 7250 under a 500 step says
  // 7250, which is what the page uses and what a save keeps (F5b review L5). The slider
  // snaps the values the editor moves.
  const shown = set ? clampToRange(value, range) : clampToStep(fallback, range);
  const suffix = field.range?.suffix ?? '';
  return (
    <FieldShell
      id={id}
      label={field.label}
      required={field.required}
      hint={field.help}
      error={error}
    >
      <div className="range">
        <input
          id={id}
          type="range"
          min={range.min}
          max={range.max}
          step={range.step}
          value={shown}
          aria-valuetext={`${shown}${suffix}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, { hint: field.help, error })}
          onChange={(e) => onChange(field.name, clampToStep(Number(e.target.value), range))}
        />
        <output htmlFor={id}>
          {shown}
          {suffix}
          {!set && <span className="range__unset"> (not set)</span>}
        </output>
      </div>
    </FieldShell>
  );
}
