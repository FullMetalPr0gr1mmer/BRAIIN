import { arrowStep } from '../roving';

// The Sortable core (Admin v2 F4b, docs/admin-v2/ui.md §2.5, AV-07): reordering one list,
// or moving items between several (the dashboard's columns), by pointer, by keyboard, or
// by visible Move buttons. Vanilla, so a server-rendered screen can use it with no React,
// and kit/useSortable.ts wraps it for islands.
//
// Two halves:
//   sortReducer   a pure state machine: lift, step, shift (to the next list), place
//                 (pointer), drop, cancel, and the one-shot button moves. It returns the
//                 next state, what to announce, and the order to save when a move is
//                 final. Unit-tested in Node (tests/lib/sortable.spec.ts).
//   createSortable  binds it to the DOM: keyboard and pointer events on the handles,
//                 clicks on the Move buttons, a live region for the announcements, and an
//                 `apply` that puts the items in order (moving the elements by default; an
//                 island passes its own, which re-renders). Driven in a browser by
//                 tests/admin/kit.e2e.ts.
//
// Accessibility (WCAG 2.2):
//   - keyboard: Space or Enter lifts and drops, the arrows move, Escape cancels; each step
//     is announced ("Hero, position 3 of 9."), so the order is never only visual;
//   - 2.5.7 Dragging Movements: every item also has Move up / Move down buttons (and, in
//     several lists, Move to the previous / next list), always present, one click each;
//   - 2.5.8 Target Size: the handle is 44px and the buttons at least 24px (admin.css).
// The pointer drag follows the finger with a CSSOM transform (style-src allows the CSSOM;
// a style attribute in markup would be refused) and inserts at the midpoint it crosses.
//
// Markup it binds (a single list may be the root itself):
//   [data-sortable]                      the root (a list or a set of lists)
//     [data-sortable-list="key"]         a list; `data-sortable-list-label` names it
//       [data-sortable-id][data-sortable-label]  an item
//         button[data-sortable-handle]   "Reorder <label>"
//         button[data-sortable-move="up|down|prev|next"]

/** Item ids per list key, in order. */
export type SortLists = Readonly<Record<string, readonly string[]>>;

export interface SortContext {
  /** The list keys in their visual order (one key for a single list). */
  order: readonly string[];
  /** An item's name, for the announcements. */
  label: (id: string) => string;
  /** A list's name ("Left column"), said when there are several. */
  listLabel?: (key: string) => string;
}

export interface SortState {
  lists: SortLists;
  /** The item being moved and the order before it was lifted (cancel restores it). */
  lifted: { id: string; origin: SortLists } | null;
}

export type SortAction =
  | { type: 'lift'; id: string }
  | { type: 'step'; delta: -1 | 1 }
  | { type: 'shift'; delta: -1 | 1 }
  | { type: 'place'; list: string; index: number }
  | { type: 'drop' }
  | { type: 'cancel' }
  | { type: 'move'; id: string; delta: -1 | 1 }
  | { type: 'moveList'; id: string; delta: -1 | 1 };

export interface SortResult {
  state: SortState;
  /** A sentence for the live region, or null for nothing to say. */
  announce: string | null;
  /** The new order when a move is final and changed something; null otherwise. */
  commit: SortLists | null;
}

/** Where an item is: its list and its 0-based index there. */
export function locate(lists: SortLists, id: string): { list: string; index: number } | null {
  for (const [list, ids] of Object.entries(lists)) {
    const index = ids.indexOf(id);
    if (index !== -1) return { list, index };
  }
  return null;
}

/** The lists with `id` taken out and put at `index` of `list` (clamped to its length). */
export function moveItem(lists: SortLists, id: string, list: string, index: number): SortLists {
  const out: Record<string, string[]> = {};
  for (const [key, ids] of Object.entries(lists)) out[key] = ids.filter((x) => x !== id);
  const target = out[list] ?? [];
  target.splice(Math.max(0, Math.min(index, target.length)), 0, id);
  out[list] = target;
  return out;
}

/** True when two orders are the same. */
export function sameOrder(a: SortLists, b: SortLists): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const x = a[key] ?? [];
    const y = b[key] ?? [];
    if (x.length !== y.length || x.some((id, i) => id !== y[i])) return false;
  }
  return true;
}

/** "position 2 of 9", and " in Left column" when there are several lists. */
function position(lists: SortLists, id: string, ctx: SortContext): string {
  const at = locate(lists, id);
  if (!at) return '';
  const size = lists[at.list]?.length ?? 0;
  const where =
    ctx.order.length > 1 ? ` in ${ctx.listLabel ? ctx.listLabel(at.list) : at.list}` : '';
  return `position ${at.index + 1} of ${size}${where}`;
}

const HOW_TO = 'Use the arrow keys to move it, Space to drop it, or Escape to cancel.';

/** The next state, its announcement and what to save, for one action. */
export function sortReducer(state: SortState, action: SortAction, ctx: SortContext): SortResult {
  const none: SortResult = { state, announce: null, commit: null };
  const { lists, lifted } = state;

  switch (action.type) {
    case 'lift': {
      if (lifted || !locate(lists, action.id)) return none;
      const next = { lists, lifted: { id: action.id, origin: lists } };
      const name = ctx.label(action.id);
      return {
        state: next,
        announce: `${name} lifted, ${position(lists, action.id, ctx)}. ${HOW_TO}`,
        commit: null,
      };
    }

    case 'step':
    case 'shift': {
      if (!lifted) return none;
      const moved = shifted(lists, lifted.id, action, ctx);
      const name = ctx.label(lifted.id);
      if (!moved) return { state, announce: edge(name, lists, lifted.id, action), commit: null };
      return {
        state: { lists: moved, lifted },
        announce: `${name}, ${position(moved, lifted.id, ctx)}.`,
        commit: null,
      };
    }

    case 'place': {
      if (!lifted || !(action.list in lists)) return none;
      const at = locate(lists, lifted.id);
      const moved = moveItem(lists, lifted.id, action.list, action.index);
      if (at && sameOrder(moved, lists)) return none;
      return { state: { lists: moved, lifted }, announce: null, commit: null };
    }

    case 'drop': {
      if (!lifted) return none;
      const changed = !sameOrder(lists, lifted.origin);
      return {
        state: { lists, lifted: null },
        announce: `${ctx.label(lifted.id)} dropped, ${position(lists, lifted.id, ctx)}.`,
        commit: changed ? lists : null,
      };
    }

    case 'cancel': {
      if (!lifted) return none;
      return {
        state: { lists: lifted.origin, lifted: null },
        announce: `Reorder cancelled. ${ctx.label(lifted.id)} is back at ${position(lifted.origin, lifted.id, ctx)}.`,
        commit: null,
      };
    }

    case 'move':
    case 'moveList': {
      if (lifted || !locate(lists, action.id)) return none;
      const step = {
        type: action.type === 'move' ? 'step' : 'shift',
        delta: action.delta,
      } as const;
      const moved = shifted(lists, action.id, step, ctx);
      const name = ctx.label(action.id);
      if (!moved) return { state, announce: edge(name, lists, action.id, step), commit: null };
      return {
        state: { lists: moved, lifted: null },
        announce: `${name} moved to ${position(moved, action.id, ctx)}.`,
        commit: moved,
      };
    }
  }
}

/** The order after one step within the list or one list across, or null at an edge. */
function shifted(
  lists: SortLists,
  id: string,
  action: { type: 'step' | 'shift'; delta: -1 | 1 },
  ctx: SortContext,
): SortLists | null {
  const at = locate(lists, id);
  if (!at) return null;
  if (action.type === 'step') {
    const size = lists[at.list]?.length ?? 0;
    const index = at.index + action.delta;
    if (index < 0 || index >= size) return null;
    return moveItem(lists, id, at.list, index);
  }
  const listIndex = ctx.order.indexOf(at.list) + action.delta;
  const target = ctx.order[listIndex];
  if (listIndex < 0 || target === undefined) return null;
  // Same height where the target list has room, else its end.
  return moveItem(lists, id, target, at.index);
}

/** What to say when a move would leave the list or the set of lists. */
function edge(
  name: string,
  lists: SortLists,
  id: string,
  action: { type: 'step' | 'shift'; delta: -1 | 1 },
): string {
  if (action.type === 'shift') {
    return `${name} is already in the ${action.delta < 0 ? 'first' : 'last'} list.`;
  }
  const at = locate(lists, id);
  const size = at ? (lists[at.list]?.length ?? 0) : 0;
  return size <= 1
    ? `${name} is the only item.`
    : `${name} is already ${action.delta < 0 ? 'first' : 'last'}.`;
}

// ---- The DOM binder ---------------------------------------------------------------------

export interface SortableChange {
  /** The item that moved. */
  id: string;
}

export interface SortableOptions {
  /** A move is final (dropped, or a Move button): save the new order. */
  onCommit: (lists: SortLists, change: SortableChange) => void;
  /**
   * Puts the items in an order. By default the item elements are moved; an island passes
   * a function that re-renders synchronously (kit/useSortable.ts uses flushSync), so React
   * keeps owning its DOM.
   */
  apply?: (lists: SortLists) => void;
  /** Items run down each list (the default) or across it. */
  orientation?: 'vertical' | 'horizontal';
  /**
   * The live region that says each step. Render it beside the list, in the same container
   * (kit/Sortable.tsx's SortHint does, and useSortable passes it): inside a modal dialog
   * when the list is, where it is heard.
   */
  live?: HTMLElement | null;
}

export interface Sortable {
  destroy: () => void;
}

/** How far a pointer travels before a press on the handle becomes a drag. */
const DRAG_THRESHOLD = 4;
/** The band at a scroll container's edge where a drag scrolls it, and the step. */
const SCROLL_EDGE = 48;
const SCROLL_STEP = 12;

/** What each Move button does. */
const MOVES: Record<string, readonly ['move' | 'moveList', -1 | 1]> = {
  up: ['move', -1],
  down: ['move', 1],
  prev: ['moveList', -1],
  next: ['moveList', 1],
};

export function createSortable(root: HTMLElement, options: SortableOptions): Sortable {
  const orientation = options.orientation ?? 'vertical';
  const doc = root.ownerDocument;
  const win = doc.defaultView ?? window;

  // The live region: the one passed in (`options.live`, which useSortable takes from
  // SortHint), else one in the markup (`[data-sortable-live]` inside the root), else one
  // added here: never inside the root, where a <p> in a <ul> would break the list, but in
  // the root's <dialog> when it sits in one (showModal() makes everything outside the
  // dialog inert, so a region on the body would be silent while a Modal or Drawer is
  // open), else on the body. Either way it exists before the first announcement: a region
  // added together with its first message announces nothing.
  const provided = options.live ?? root.querySelector<HTMLElement>('[data-sortable-live]');
  const live = provided ?? doc.createElement('p');
  if (!provided) {
    live.className = 'visually-hidden';
    live.setAttribute('aria-live', 'assertive');
    live.setAttribute('aria-atomic', 'true');
    (root.closest('dialog') ?? doc.body).appendChild(live);
  }

  const listEls = (): HTMLElement[] => {
    const nested = [...root.querySelectorAll<HTMLElement>('[data-sortable-list]')];
    return nested.length > 0 ? nested : [root];
  };
  const keyOf = (list: HTMLElement) => list.dataset['sortableList'] || 'list';
  const itemsOf = (list: HTMLElement) =>
    [...list.children].filter(
      (el): el is HTMLElement =>
        el instanceof HTMLElement && el.dataset['sortableId'] !== undefined,
    );
  const itemEl = (id: string) =>
    [...root.querySelectorAll<HTMLElement>('[data-sortable-id]')].find(
      (el) => el.dataset['sortableId'] === id,
    ) ?? null;
  const handleOf = (id: string) =>
    itemEl(id)?.querySelector<HTMLElement>('[data-sortable-handle]') ?? null;
  const readLists = (): SortLists =>
    Object.fromEntries(
      listEls().map((list) => [
        keyOf(list),
        itemsOf(list).map((el) => el.dataset['sortableId'] ?? ''),
      ]),
    );
  const context = (): SortContext => ({
    order: listEls().map(keyOf),
    label: (id) => itemEl(id)?.dataset['sortableLabel'] || 'Item',
    listLabel: (key) =>
      listEls().find((list) => keyOf(list) === key)?.dataset['sortableListLabel'] || key,
  });

  // Only a lift holds state: between moves the DOM is the truth (an island may re-render
  // the list at any time), so the order is read afresh when nothing is lifted.
  let lifted: SortState['lifted'] = null;
  let liftedOrder: SortLists | null = null;
  // True while `apply` moves elements: moving a focused element blurs it, which must not
  // read as the person leaving the handle.
  let applying = false;

  const domApply = (lists: SortLists) => {
    for (const list of listEls()) {
      for (const id of lists[keyOf(list)] ?? []) {
        const el = itemEl(id);
        if (el) list.appendChild(el);
      }
    }
  };

  /** Marks the Move buttons that would go nowhere aria-disabled (still focusable). */
  const syncButtons = () => {
    const lists = listEls();
    lists.forEach((list, listIndex) => {
      const items = itemsOf(list);
      items.forEach((item, index) => {
        const off: Record<string, boolean> = {
          up: index === 0,
          down: index === items.length - 1,
          prev: listIndex === 0,
          next: listIndex === lists.length - 1,
        };
        for (const button of item.querySelectorAll<HTMLElement>('[data-sortable-move]')) {
          if (off[button.dataset['sortableMove'] ?? '']) {
            button.setAttribute('aria-disabled', 'true');
          } else {
            button.removeAttribute('aria-disabled');
          }
        }
      });
    });
  };

  const markLifted = () => {
    for (const el of root.querySelectorAll<HTMLElement>('[data-sortable-lifted]')) {
      if (el.dataset['sortableId'] !== lifted?.id) delete el.dataset['sortableLifted'];
    }
    const el = lifted ? itemEl(lifted.id) : null;
    if (el) el.dataset['sortableLifted'] = '';
  };

  /**
   * Runs one action: the new order on screen, focus put back on `refocus(id)`, the words
   * said, and the order saved when the move is final.
   */
  function run(action: SortAction, refocus: (id: string) => HTMLElement | null) {
    const id = 'id' in action ? action.id : lifted?.id;
    const current: SortState = { lists: liftedOrder ?? readLists(), lifted };
    const result = sortReducer(current, action, context());
    lifted = result.state.lifted;
    liftedOrder = lifted ? result.state.lists : null;
    if (!sameOrder(result.state.lists, readLists())) {
      applying = true;
      try {
        (options.apply ?? domApply)(result.state.lists);
      } finally {
        applying = false;
      }
      if (id) refocus(id)?.focus();
    }
    markLifted();
    syncButtons();
    if (result.announce) live.textContent = result.announce;
    if (result.commit && id) options.onCommit(result.commit, { id });
  }

  // ---- Keyboard, on a handle ----
  function onKeyDown(event: KeyboardEvent) {
    const handle = (event.target as Element | null)?.closest<HTMLElement>('[data-sortable-handle]');
    const item = handle?.closest<HTMLElement>('[data-sortable-id]');
    if (!handle || !item || !root.contains(item)) return;
    const id = item.dataset['sortableId'] ?? '';
    const key = event.key;

    if (!lifted) {
      if (key === ' ' || key === 'Enter') {
        event.preventDefault();
        run({ type: 'lift', id }, handleOf);
      }
      return;
    }
    if (lifted.id !== id) return;

    const rtl = win.getComputedStyle(item).direction === 'rtl';
    const along = arrowStep(key, { orientation, rtl });
    const across = arrowStep(key, {
      orientation: orientation === 'vertical' ? 'horizontal' : 'vertical',
      rtl,
    });
    const action: SortAction | null =
      key === ' ' || key === 'Enter'
        ? { type: 'drop' }
        : key === 'Escape'
          ? { type: 'cancel' }
          : along !== 0
            ? { type: 'step', delta: along }
            : across !== 0
              ? { type: 'shift', delta: across }
              : null;
    if (!action) return;
    // Handled here: the page does not scroll, and Escape does not also close a dialog.
    event.preventDefault();
    event.stopPropagation();
    run(action, handleOf);
  }

  // Leaving the handle while an item is lifted puts the item back: a half-made move is
  // never saved by accident.
  function onFocusOut(event: FocusEvent) {
    if (applying || drag || !lifted) return;
    const handle = handleOf(lifted.id);
    if (event.target === handle && event.relatedTarget !== handle) {
      run({ type: 'cancel' }, () => null);
    }
  }

  // ---- The Move buttons ----
  function onClick(event: MouseEvent) {
    const button = (event.target as Element | null)?.closest<HTMLElement>('[data-sortable-move]');
    const item = button?.closest<HTMLElement>('[data-sortable-id]');
    const move = MOVES[button?.dataset['sortableMove'] ?? ''];
    if (!button || !item || !move || !root.contains(item) || lifted) return;
    event.preventDefault();
    const kind = button.dataset['sortableMove'] ?? '';
    run(
      { type: move[0], id: item.dataset['sortableId'] ?? '', delta: move[1] },
      (id) => itemEl(id)?.querySelector<HTMLElement>(`[data-sortable-move="${kind}"]`) ?? null,
    );
  }

  // ---- Pointer drag, from a handle ----
  let drag: {
    id: string;
    pointerId: number;
    handle: HTMLElement;
    startX: number;
    startY: number;
    startRect: DOMRect;
    started: boolean;
  } | null = null;

  function onPointerDown(event: PointerEvent) {
    if (event.button !== 0 || !event.isPrimary || lifted) return;
    const handle = (event.target as Element | null)?.closest<HTMLElement>('[data-sortable-handle]');
    const item = handle?.closest<HTMLElement>('[data-sortable-id]');
    if (!handle || !item || !root.contains(item)) return;
    handle.setPointerCapture(event.pointerId);
    // The rest of the drag is heard on the document, not the root: reordering moves the
    // dragged item's element (React's insertBefore, or appendChild here), and moving an
    // element out of the tree releases its pointer capture, after which the pointer may
    // leave the root before it is let go.
    for (const [type, fn] of dragListeners) doc.addEventListener(type, fn as EventListener);
    drag = {
      id: item.dataset['sortableId'] ?? '',
      pointerId: event.pointerId,
      handle,
      startX: event.clientX,
      startY: event.clientY,
      startRect: item.getBoundingClientRect(),
      started: false,
    };
  }

  function onPointerMove(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.started) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      drag.started = true;
      run({ type: 'lift', id: drag.id }, () => null);
    }
    const el = itemEl(drag.id);
    if (!el) return;
    el.dataset['sortableDragging'] = '';
    // Measure where the item sits without the drag offset, insert it at the midpoint the
    // pointer has crossed, then offset it again so it stays under the pointer.
    el.style.transform = '';
    const target = listAt(event.clientX, event.clientY);
    if (target) {
      const others = itemsOf(target).filter((x) => x !== el);
      const index = others.findIndex((x) => {
        const r = x.getBoundingClientRect();
        return orientation === 'vertical'
          ? event.clientY < r.top + r.height / 2
          : event.clientX < r.left + r.width / 2;
      });
      run(
        { type: 'place', list: keyOf(target), index: index === -1 ? others.length : index },
        () => null,
      );
    }
    const moved = itemEl(drag.id);
    if (!moved) return;
    const now = moved.getBoundingClientRect();
    const tx = Math.round(drag.startRect.left + dx - now.left);
    const ty = Math.round(drag.startRect.top + dy - now.top);
    moved.dataset['sortableDragging'] = '';
    moved.style.transform = `translate(${tx}px, ${ty}px)`;
    autoScroll(moved, event.clientY);
  }

  function endDrag(event: PointerEvent, action: 'drop' | 'cancel') {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { id, started, handle } = drag;
    drag = null;
    for (const [type, fn] of dragListeners) doc.removeEventListener(type, fn as EventListener);
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    const el = itemEl(id);
    if (el) {
      el.style.transform = '';
      delete el.dataset['sortableDragging'];
    }
    if (started) run({ type: action }, handleOf);
  }
  const onPointerUp = (event: PointerEvent) => endDrag(event, 'drop');
  const onPointerCancel = (event: PointerEvent) => endDrag(event, 'cancel');

  /** The list under a point; with one list, that list wherever the pointer is. */
  function listAt(x: number, y: number): HTMLElement | null {
    const lists = listEls();
    if (lists.length === 1) return lists[0] ?? null;
    return (
      lists.find((list) => {
        const r = list.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      }) ?? null
    );
  }

  /** Scrolls the item's scroll container (or the page) while the pointer is at its edge. */
  function autoScroll(el: HTMLElement, y: number) {
    let box: HTMLElement | null = el.parentElement;
    while (box && box !== doc.body && box !== doc.documentElement) {
      const overflow = win.getComputedStyle(box).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && box.scrollHeight > box.clientHeight) {
        break;
      }
      box = box.parentElement;
    }
    const scroller = box && box !== doc.body && box !== doc.documentElement ? box : null;
    const rect = scroller?.getBoundingClientRect();
    const top = rect ? rect.top : 0;
    const bottom = rect ? rect.bottom : win.innerHeight;
    const by = y < top + SCROLL_EDGE ? -SCROLL_STEP : y > bottom - SCROLL_EDGE ? SCROLL_STEP : 0;
    if (by !== 0) (scroller ?? win).scrollBy(0, by);
  }

  const listeners: [string, (event: never) => void][] = [
    ['keydown', onKeyDown],
    ['focusout', onFocusOut],
    ['click', onClick],
    ['pointerdown', onPointerDown],
  ];
  // Added on the document while a press on a handle lasts (onPointerDown, endDrag).
  const dragListeners: [string, (event: never) => void][] = [
    ['pointermove', onPointerMove],
    ['pointerup', onPointerUp],
    ['pointercancel', onPointerCancel],
  ];
  for (const [type, fn] of listeners) root.addEventListener(type, fn as EventListener);
  syncButtons();

  // The Move buttons' aria-disabled follows the order whoever changes it. The binder's own
  // moves sync in run(); this catches the rest: the list's owner adding or removing an
  // item, putting an order back after a failed save, a refresh. It watches children
  // added, removed or moved under the root; syncButtons only sets attributes, so it never
  // wakes the observer itself.
  const watcher =
    typeof win.MutationObserver === 'function' ? new win.MutationObserver(syncButtons) : null;
  watcher?.observe(root, { childList: true, subtree: true });

  return {
    destroy() {
      watcher?.disconnect();
      for (const [type, fn] of listeners) root.removeEventListener(type, fn as EventListener);
      for (const [type, fn] of dragListeners) doc.removeEventListener(type, fn as EventListener);
      drag = null;
      if (!provided) live.remove();
    },
  };
}
