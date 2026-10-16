import { DASH_COLUMNS, isWidgetId, type DashColumn, type WidgetId } from '@schemas/dashboard';
import { createSortable, type SortLists } from '@/lib/admin/client/sortable';

// Customize (Admin v2 U1, ui.md §4 "Customize"): the Sortable core (F4b) bound to the board
// the server rendered, so the widgets move by pointer, by keyboard (Space or Enter lifts, the
// arrows move within and across the columns, Space drops, Escape cancels) and by each
// widget's Move buttons, one click each (WCAG 2.5.7); every step is said in a live region.
// The core moves the server's elements itself (its default `apply`); React owns none of
// them. Hide takes a widget off the board. Each final move or hide is handed to `onChange`
// with the new order, which saves it.

export type BoardLists = Record<DashColumn, WidgetId[]>;

export interface CustomizeOptions {
  /** A move or a hide is final: the board's new order, and the widget hidden, if one was. */
  onChange: (lists: BoardLists, hidden: WidgetId | null) => void;
  /** Where the binder says what happened (the bar's live region). */
  live: HTMLElement | null;
}

export interface Customize {
  stop: () => void;
}

const WHERE: Record<DashColumn, string> = {
  top: 'to the top row',
  left: 'to the left column',
  right: 'to the right column',
};

/** The board's order as the DOM has it now. */
export function readBoard(root: HTMLElement): BoardLists {
  const out: BoardLists = { top: [], left: [], right: [] };
  for (const column of DASH_COLUMNS) {
    const list = root.querySelector<HTMLElement>(`[data-sortable-list="${column}"]`);
    for (const el of list ? [...list.children] : []) {
      const id = (el as HTMLElement).dataset['sortableId'];
      if (isWidgetId(id)) out[column].push(id);
    }
  }
  return out;
}

/** Names each widget's column buttons for where they lead from its column now. */
export function relabel(root: HTMLElement): void {
  DASH_COLUMNS.forEach((column, index) => {
    const list = root.querySelector<HTMLElement>(`[data-sortable-list="${column}"]`);
    for (const el of list ? [...list.children] : []) {
      const prev = DASH_COLUMNS[index - 1];
      const next = DASH_COLUMNS[index + 1];
      for (const [kind, target] of [
        ['prev', prev],
        ['next', next],
      ] as const) {
        const button = el.querySelector<HTMLElement>(`[data-sortable-move="${kind}"]`);
        const base = button?.dataset['wgMoveLabel'];
        if (!button || !base) continue;
        button.setAttribute(
          'aria-label',
          target ? `${base} ${WHERE[target]}` : `${base} ${kind === 'prev' ? 'up a column' : 'down a column'}`,
        );
      }
    }
  });
}

export function startCustomize(root: HTMLElement, options: CustomizeOptions): Customize {
  root.dataset['editing'] = '';
  for (const controls of root.querySelectorAll<HTMLElement>('[data-wg-controls]')) {
    controls.hidden = false;
  }
  relabel(root);

  const sortable = createSortable(root, {
    live: options.live,
    onCommit: (lists: SortLists) => {
      relabel(root);
      options.onChange(
        {
          top: (lists['top'] ?? []).filter(isWidgetId),
          left: (lists['left'] ?? []).filter(isWidgetId),
          right: (lists['right'] ?? []).filter(isWidgetId),
        },
        null,
      );
    },
  });

  function onHide(event: MouseEvent) {
    const button = (event.target as Element | null)?.closest<HTMLElement>('[data-wg-hide]');
    const widget = button?.closest<HTMLElement>('[data-sortable-id]');
    const id = widget?.dataset['sortableId'];
    if (!button || !widget || !isWidgetId(id) || !root.contains(widget)) return;
    event.preventDefault();
    const label = widget.dataset['sortableLabel'] ?? 'The widget';
    // Focus moves to the next widget's handle (or the previous one's), never to the body.
    const list = widget.parentElement;
    const siblings = list ? [...list.children] : [];
    const at = siblings.indexOf(widget);
    const neighbour = (siblings[at + 1] ?? siblings[at - 1]) as HTMLElement | undefined;
    widget.remove();
    neighbour?.querySelector<HTMLElement>('[data-sortable-handle]')?.focus();
    if (options.live) options.live.textContent = `${label} hidden. Add it back with Add widget.`;
    options.onChange(readBoard(root), id);
  }
  root.addEventListener('click', onHide);

  return {
    stop() {
      sortable.destroy();
      root.removeEventListener('click', onHide);
      delete root.dataset['editing'];
      for (const controls of root.querySelectorAll<HTMLElement>('[data-wg-controls]')) {
        controls.hidden = true;
      }
    },
  };
}
