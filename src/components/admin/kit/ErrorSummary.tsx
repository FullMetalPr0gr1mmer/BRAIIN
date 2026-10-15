import { useEffect, useId, useRef, type MouseEvent } from 'react';
import { revealAndFocus } from '@/components/admin/fields/reveal';

// The error summary (Admin v2 F4b, ui.md AV-08 uses it): after a save the server refused,
// one block at the top of the form that says how many things need fixing, lists them,
// and links each to its field. It takes focus when it appears (so a keyboard or screen
// reader user lands on it, not on a button that did nothing visible) and each link moves
// focus to the field itself, not just the scroll position. Field errors also stay inline
// beside each field; this is the way to them. A field can be on the form but out of sight
// (the Arabic half while the editor shows English, a collapsed repeater item): the link
// asks for it to be shown first (fields/reveal.ts, F5a) and focuses it on the next frame.

export interface FieldError {
  /** The field's element id; without one the error is listed but not linked. */
  id?: string | undefined;
  message: string;
}

export interface ErrorSummaryProps {
  errors: readonly FieldError[];
  title?: string | undefined;
  /** Take focus when the errors change (the default). */
  focus?: boolean;
}

/** "Fix 1 problem to save" / "Fix 3 problems to save". */
export function errorSummaryTitle(count: number): string {
  return count === 1 ? 'Fix 1 problem to save' : `Fix ${count} problems to save`;
}

export default function ErrorSummary({ errors, title, focus = true }: ErrorSummaryProps) {
  const box = useRef<HTMLDivElement>(null);
  const headingId = useId();
  // A new set of errors (not a re-render of the same ones) takes focus.
  const signature = errors.map((e) => `${e.id ?? ''}\u0000${e.message}`).join('\u0001');
  useEffect(() => {
    if (focus && signature) box.current?.focus();
  }, [focus, signature]);

  if (errors.length === 0) return null;

  function jump(event: MouseEvent<HTMLAnchorElement>, id: string) {
    if (revealAndFocus(id)) event.preventDefault();
  }

  return (
    <div ref={box} className="error-summary" role="alert" tabIndex={-1} aria-labelledby={headingId}>
      <h2 id={headingId}>{title ?? errorSummaryTitle(errors.length)}</h2>
      <ul>
        {errors.map((error, index) => (
          <li key={`${error.id ?? ''}-${index}`}>
            {error.id ? (
              <a href={`#${error.id}`} onClick={(event) => jump(event, error.id as string)}>
                {error.message}
              </a>
            ) : (
              error.message
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
