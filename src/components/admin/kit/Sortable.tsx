import Icon from './Icon';

// The controls a sortable row carries (Admin v2 F4b, ui.md §2.5), for the Sortable core
// (src/lib/admin/client/sortable.ts) to bind:
//   SortHandle   the 44px handle, "Reorder <name>": drag it, or Space to lift, the
//                arrows to move, Space to drop, Escape to cancel. Its description is the
//                SortHint, so the keys are told before the first press.
//   MoveButtons  Move up / Move down (and, across several lists, to the previous or
//                next one): always shown, one click each, so nothing needs a drag (WCAG
//                2.5.7). The core marks the ones that would go nowhere aria-disabled.
//   SortHint     the instructions, hidden, read as the handles' description, and the
//                live region that says each step (useSortable hands it to the core).
//                Render it beside the list, in the same container: in a Modal or Drawer,
//                only what is inside the dialog is heard.
// A server-rendered list renders the same attributes and calls createSortable itself.

export const SORT_HINT =
  'To reorder, press Space or Enter, move with the arrow keys, and press Space again to drop. Escape cancels.';

export function SortHandle({ label, describedBy }: { label: string; describedBy?: string }) {
  return (
    <button
      type="button"
      className="drag"
      data-sortable-handle=""
      aria-label={`Reorder ${label}`}
      aria-describedby={describedBy}
    >
      <Icon name="drag" size={18} />
    </button>
  );
}

export function MoveButtons({ label, lists = false }: { label: string; lists?: boolean }) {
  return (
    <span className="li__move">
      <button
        type="button"
        className="icon-btn"
        data-sortable-move="up"
        aria-label={`Move ${label} up`}
      >
        <Icon name="chevd" size={14} className="ic--flip" />
      </button>
      <button
        type="button"
        className="icon-btn"
        data-sortable-move="down"
        aria-label={`Move ${label} down`}
      >
        <Icon name="chevd" size={14} />
      </button>
      {lists && (
        <>
          <button
            type="button"
            className="icon-btn"
            data-sortable-move="prev"
            aria-label={`Move ${label} to the previous list`}
          >
            <Icon name="back" size={14} />
          </button>
          <button
            type="button"
            className="icon-btn"
            data-sortable-move="next"
            aria-label={`Move ${label} to the next list`}
          >
            <Icon name="arrow" size={14} />
          </button>
        </>
      )}
    </span>
  );
}

/** The id of the live region SortHint renders for the hint `id`. */
export const sortLiveId = (hintId: string) => `${hintId}-live`;

export function SortHint({ id }: { id: string }) {
  return (
    <>
      <p id={id} hidden>
        {SORT_HINT}
      </p>
      <p
        id={sortLiveId(id)}
        className="visually-hidden"
        aria-live="assertive"
        aria-atomic="true"
        data-sortable-live=""
      />
    </>
  );
}
