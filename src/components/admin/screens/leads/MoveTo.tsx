import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { StageView } from '@/lib/crm/leadPage';

// "Move to…" (Admin v2 C4b, crm.md §11 screen 2; decision D11): the one way a lead changes
// stage by keyboard or by a single press, on every board card and on the lead's own page
// (WCAG 2.1.1 Keyboard, 2.5.7 Dragging Movements: a move never needs a drag). A disclosure:
// a button (aria-expanded) that shows a short list of the other stages as buttons, each at
// least 24px tall (2.5.8). Arrow keys step through the list, Escape closes it and puts focus
// back on the button, a press outside closes it. Not a native <select>: Windows browsers fire
// `change` on every arrow key, which would move a lead by accident.
//
// Its name says whose card it is ("Move to… Sara"): the visible words come first, so the
// spoken name starts with what is seen (WCAG 2.5.3).
//
// Choosing a stage closes the list, which held focus, and the caller usually disables the
// button while the move is saved: a focused button that turns disabled drops focus to the
// body (WCAG 2.4.3 Focus Order). So the button takes focus back once it is enabled again,
// unless the person has gone somewhere else meanwhile (focusAfterMove).

export interface MoveToProps {
  /** The lead's name, for the button's name. */
  name: string;
  stages: readonly StageView[];
  /** The stage the lead is in now (left out of the list). */
  current: unknown;
  /** Moves the lead; the caller announces the outcome. */
  onMove: (stage: StageView) => void;
  disabled?: boolean;
  className?: string | undefined;
}

/**
 * Whether the button takes focus back now: a stage was chosen here (`pending`), the button is
 * enabled again, and focus is lost (nothing, or the body) or still on the button. Never taken
 * from wherever the person went while the move was saved.
 */
export function focusAfterMove(
  pending: boolean,
  off: boolean,
  active: Element | null,
  button: Element | null,
  body: Element | null,
): boolean {
  if (!pending || off || !button) return false;
  return active === null || active === body || active === button;
}

export default function MoveTo({
  name,
  stages,
  current,
  onMove,
  disabled = false,
  className,
}: MoveToProps) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();
  const targets = stages.filter((stage) => stage.id !== current);
  const off = disabled || targets.length === 0;
  // A stage was chosen here and focus has not been given back yet.
  const pending = useRef(false);

  // The move settled (the button is enabled again): focus returns to it (see above).
  useEffect(() => {
    if (off) return;
    if (focusAfterMove(pending.current, off, document.activeElement, button.current, document.body))
      button.current?.focus();
    pending.current = false;
  }, [off]);

  // Open: focus the first stage. A press anywhere outside closes the list.
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const away = (event: PointerEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  function close(refocus: boolean) {
    setOpen(false);
    if (refocus) button.current?.focus();
  }

  function onKey(event: KeyboardEvent<HTMLUListElement>) {
    const items = [...(list.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      (event.key === 'Home' ? items[0] : items.at(-1))?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  }

  return (
    <div className={`moveto${className ? ` ${className}` : ''}`} ref={box}>
      <button
        ref={button}
        type="button"
        data-size="sm"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={off}
        onClick={() => setOpen((was) => !was)}
      >
        Move to…<span className="visually-hidden"> {name}</span>
      </button>
      {open && (
        <ul
          id={listId}
          ref={list}
          className="moveto__m"
          aria-label={`Stages to move ${name} to`}
          onKeyDown={onKey}
        >
          {targets.map((stage) => (
            <li key={stage.id}>
              <button
                type="button"
                onClick={() => {
                  pending.current = true;
                  // Focus goes back to the button at once; the effect above gives it back
                  // again if the caller's save disables the button meanwhile.
                  close(true);
                  onMove(stage);
                }}
              >
                {stage.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
