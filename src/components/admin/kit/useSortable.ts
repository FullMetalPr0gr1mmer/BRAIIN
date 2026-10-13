import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import {
  createSortable,
  sameOrder,
  type SortableChange,
  type SortLists,
} from '@/lib/admin/client/sortable';

// The Sortable core for islands (Admin v2 F4b, ui.md §2.5): the vanilla binder
// (src/lib/admin/client/sortable.ts) on a list React renders. The binder never moves
// React's elements: it hands each new order to `apply`, which re-renders synchronously
// (flushSync), so the binder can put focus back on the moved item's handle at once and
// React keeps owning its DOM.
//
//   const { ref, lists, hintId } = useSortable({ lists: { list: ids }, onCommit });
//   <ul className="list" ref={ref}>{lists.list.map(id => <ListRow sortId={id} … />)}</ul>
//   <SortHint id={hintId} />   (kit/Sortable.tsx; each SortHandle gets describedBy={hintId})
//
// `onCommit` receives the final order (a drop, or a Move button). Update your own order
// in it, at once: the preview ends with the commit, and an order that waits for a server
// round trip would jump back first. A move that ends where it began (a cancel, or a drop
// back in place) ends the preview too, so the list follows `options.lists` again.

export interface UseSortableOptions {
  lists: SortLists;
  onCommit: (lists: SortLists, change: SortableChange) => void;
  orientation?: 'vertical' | 'horizontal';
}

export interface UseSortable<E extends HTMLElement> {
  ref: RefObject<E | null>;
  /** The order to render: the move in progress, else `options.lists`. */
  lists: SortLists;
  /** The id for the handles' aria-describedby (the instructions). */
  hintId: string;
}

export function useSortable<E extends HTMLElement = HTMLElement>(
  options: UseSortableOptions,
): UseSortable<E> {
  const ref = useRef<E | null>(null);
  const [preview, setPreview] = useState<SortLists | null>(null);
  const commit = useRef(options.onCommit);
  commit.current = options.onCommit;
  const saved = useRef(options.lists);
  saved.current = options.lists;
  const hintId = useId();
  const orientation = options.orientation ?? 'vertical';

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const sortable = createSortable(root, {
      orientation,
      apply: (lists) => flushSync(() => setPreview(sameOrder(lists, saved.current) ? null : lists)),
      onCommit: (lists, change) => {
        setPreview(null);
        commit.current(lists, change);
      },
    });
    return () => sortable.destroy();
  }, [orientation]);

  return { ref, lists: preview ?? options.lists, hintId };
}
