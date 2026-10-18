// The collection screen's order (Admin v2 U7), pure so it is unit-tested
// (tests/lib/collectionReorder.spec.ts).
//
// A list's order is its rows' `sort_order`. After a move the screen renumbers the list in
// tens, in its new order, and sends ONLY the rows whose number changed: each row is one
// update, one subrequest (README P-15: 50 a request on the Workers Free plan), so a move
// near the top of a long list costs the rows between its two ends, not the whole list.
// Ties and gaps in the stored numbers (a seed's 1, 2, 3; two rows at 0) settle on the first
// move, after which the numbers are tens and a move touches only what it passed.

export interface Positioned {
  id: string;
  sort_order: number;
}

export interface OrderChange {
  id: string;
  sortOrder: number;
}

/** The step between two rows' numbers. */
export const ORDER_STEP = 10;

/**
 * The updates that give `order` (every row's id, in the new order) as `sort_order`s: the
 * list numbered in tens from 10, keeping only the rows whose number changes. Ids `order`
 * does not hold are left alone; an id `order` holds that `rows` does not is skipped and
 * takes no place.
 */
export function orderChanges(rows: readonly Positioned[], order: readonly string[]): OrderChange[] {
  const current = new Map(rows.map((row) => [row.id, row.sort_order]));
  const changes: OrderChange[] = [];
  order
    .filter((id) => current.has(id))
    .forEach((id, index) => {
      const next = (index + 1) * ORDER_STEP;
      if (current.get(id) !== next) changes.push({ id, sortOrder: next });
    });
  return changes;
}

/** `order` with `id` placed right after `after` (a duplicate's place), or last. */
export function placeAfter(order: readonly string[], after: string, id: string): string[] {
  const rest = order.filter((each) => each !== id);
  const at = rest.indexOf(after);
  if (at === -1) return [...rest, id];
  return [...rest.slice(0, at + 1), id, ...rest.slice(at + 1)];
}
