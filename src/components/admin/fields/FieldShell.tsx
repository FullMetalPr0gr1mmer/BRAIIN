import type { ReactNode } from 'react';

// The chrome around every field of the kit (Admin v2 F5a, ui.md §2.6, the prototype's .f):
//   the label row   the label (12.5/700) and, on its right, meta (a "142/160" counter,
//                   "3 of 4 items") and an extra control (the EN | AR switch);
//   required        a star in the error colour, hidden from screen readers, and the word
//                   "required" for them instead (the control also carries aria-required);
//   the control     the caller's; it points aria-describedby at the hint and the error
//                   (describedBy()), and sets aria-invalid when there is an error;
//   the error       inline, under the control, from the API's issues (fieldErrors.ts);
//   the hint        dim, under it all.
// `as="fieldset"` for a field of several controls (a bilingual pair, a set of checkboxes,
// a media tile): the label is the group's legend, and the group itself carries the id
// (focusable by script only), so an error that names the whole field can still be linked.

export interface FieldShellProps {
  /** The control's id (a label's `for`), or the group's for a fieldset. */
  id: string;
  label: string;
  required?: boolean | undefined;
  meta?: ReactNode;
  hint?: ReactNode;
  error?: string | undefined;
  as?: 'label' | 'fieldset';
  /** A control in the label row, after the meta (the EN | AR switch). */
  labelExtra?: ReactNode;
  /** The label beside the control instead of above it (a switch). */
  inline?: boolean;
  children: ReactNode;
}

/** The ids of a field's hint and error, from its control's id. */
export function fieldIds(id: string): { hint: string; error: string } {
  return { hint: `${id}-hint`, error: `${id}-error` };
}

/** The control's aria-describedby: its hint and error, when they are shown. */
export function describedBy(
  id: string,
  shown: { hint?: unknown; error?: unknown },
): string | undefined {
  const ids = fieldIds(id);
  const list = [shown.hint ? ids.hint : null, shown.error ? ids.error : null].filter(Boolean);
  return list.length > 0 ? list.join(' ') : undefined;
}

/** The required star (seen) and the word (heard). */
export function Required() {
  return (
    <>
      {' '}
      <span className="req" aria-hidden="true">
        *
      </span>
      <span className="visually-hidden"> required</span>
    </>
  );
}

export default function FieldShell({
  id,
  label,
  required,
  meta,
  hint,
  error,
  as = 'label',
  labelExtra,
  inline = false,
  children,
}: FieldShellProps) {
  const ids = fieldIds(id);
  const tail = (
    <>
      {error && (
        <p id={ids.error} className="field-error f__err">
          {error}
        </p>
      )}
      {hint && (
        <p id={ids.hint} className="f__hint">
          {hint}
        </p>
      )}
    </>
  );
  const side = (meta || labelExtra) && (
    <>
      {meta && <span className="f__meta">{meta}</span>}
      {labelExtra}
    </>
  );

  if (as === 'fieldset') {
    return (
      <fieldset
        id={id}
        tabIndex={-1}
        className="f f--group"
        data-invalid={error ? '' : undefined}
        aria-describedby={describedBy(id, { hint, error })}
      >
        <legend className="field-legend">
          {label}
          {required && <Required />}
        </legend>
        {side && <div className="f__bar">{side}</div>}
        {children}
        {tail}
      </fieldset>
    );
  }

  return (
    <div className={inline ? 'f f--inline' : 'f'} data-invalid={error ? '' : undefined}>
      <div className="f__l">
        <label htmlFor={id} id={`${id}-label`}>
          {label}
          {required && <Required />}
        </label>
        {side}
      </div>
      {children}
      {tail}
    </div>
  );
}
