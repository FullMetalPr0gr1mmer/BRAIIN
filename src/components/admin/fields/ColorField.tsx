import { contrastRatio, contrastVerdict, formatContrast } from '@/lib/admin/contrast';
import { normalizeHex } from '@/lib/admin/fieldValues';
import FieldShell, { describedBy } from './FieldShell';
import type { FieldComponentProps } from './types';

export { normalizeHex };

// `color` (Admin v2 F5a, ui.md §2.6, the prototype's .colorf and .swatches): the browser's
// own colour picker beside the hex as text (monospace, upper case: `#RRGGBB`), optional
// swatches, and, when `color.contrastWith` names a text colour, its contrast on the chosen
// colour in words ("White text on it: 10.6:1, passes AA"), the audit's own maths
// (src/lib/admin/contrast.ts).
//
// CSP (ui.md §1.6): a swatch is painted by an SVG <rect fill>, never a style attribute, and
// only with a value normalizeHex() accepted. A hex being typed is kept as typed; the payload
// sends it uppercased (formPayload.ts) or, when it is not a colour, as typed, so the
// server's refusal names this field.

const NAMED: Record<string, string> = { '#FFFFFF': 'White', '#000000': 'Black' };

export default function ColorField({
  field,
  value,
  onChange,
  idPrefix,
  errors,
}: FieldComponentProps) {
  const id = `${idPrefix}-${field.name}`;
  const error = errors?.[id];
  const text = typeof value === 'string' ? value : '';
  const hex = normalizeHex(text);
  const swatches = (field.color?.swatches ?? [])
    .map((s) => normalizeHex(s))
    .filter((s): s is string => s !== null);
  const against = normalizeHex(field.color?.contrastWith);
  const ratio = hex && against ? contrastRatio(against, hex) : Number.NaN;
  const hint = [
    field.help,
    Number.isFinite(ratio) && against
      ? `${NAMED[against] ?? `${against} text`}${NAMED[against] ? ' text' : ''} on it: ${formatContrast(ratio)}, ${contrastVerdict(ratio)}.`
      : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <FieldShell
      id={id}
      label={field.label}
      required={field.required}
      hint={hint || undefined}
      error={error}
    >
      <div className="colorf">
        <input
          type="color"
          aria-label={`${field.label}: pick a colour`}
          // The picker needs a valid lower-case colour; an unfinished hex leaves it black.
          value={(hex ?? '#000000').toLowerCase()}
          onChange={(e) => onChange(field.name, e.target.value.toUpperCase())}
        />
        <input
          id={id}
          type="text"
          className="in--mono"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={7}
          placeholder="#0024BC"
          value={text}
          aria-required={field.required || undefined}
          aria-invalid={error || (text !== '' && !hex) ? true : undefined}
          aria-describedby={describedBy(id, { hint, error })}
          onChange={(e) => onChange(field.name, e.target.value.toUpperCase())}
        />
      </div>
      {swatches.length > 0 && (
        <div className="swatches" role="group" aria-label={`${field.label}: suggested colours`}>
          {swatches.map((swatch) => (
            <button
              key={swatch}
              type="button"
              className="swatch"
              aria-label={swatch}
              aria-pressed={hex === swatch}
              onClick={() => onChange(field.name, swatch)}
            >
              <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true" focusable="false">
                <rect x="1" y="1" width="24" height="24" rx="6" fill={swatch} />
              </svg>
            </button>
          ))}
        </div>
      )}
    </FieldShell>
  );
}
