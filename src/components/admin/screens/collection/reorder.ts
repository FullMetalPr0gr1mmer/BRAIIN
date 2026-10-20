// The collection screen's order (Admin v2 U7), pure so it is unit-tested
// (tests/lib/collectionReorder.spec.ts).
//
// A list's order is its rows' `sort_order`. After a move the screen renumbers the list in
// tens, in its new order, and sends ONLY the rows whose number changed: each row is one
// update, one subrequest (README P-15: 50 a request on the Workers Free plan), so a move
// near the top of a long list costs the rows between its two ends, not the whole list.
// Ties and gaps in the stored numbers (a seed's 1, 2, 3; two rows at 0) settle on the first
// move, after which the numbers are tens and a move touches only what it passed. Only an
// Admin's move renumbers an archived row (`renumberable`); anyone else's leaves it as it is.

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
 * The rows a move or a duplicate may renumber: every row for a person who may archive
 * (`permissions.remove`, content.archiveDelete: `app.is_admin()` in the policy), else every
 * row that is not archived (a row with no status, such as a client, is always kept). An
 * archived row is written by an Admin only (the RESTRICTIVE archive gates, 0018 on: any
 * update fails WITH CHECK while the row is archived), one refused row refuses the whole
 * move, and an archived row has no place on the site, so it keeps its number.
 */
export function renumberable<T extends Readonly<Record<string, unknown>>>(
  rows: readonly T[],
  mayArchive: boolean,
): T[] {
  return mayArchive ? [...rows] : rows.filter((row) => row['status'] !== 'archived');
}

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

/**
 * The updates that place a duplicate right after its original (brief D9): the copy and the
 * rows after the original are renumbered in tens from the original's number, and nothing
 * before the original moves, so a copy near the end of a list costs the rows after it, not
 * the list (a seed's tied 1, 2, 3 above the original stay as they are).
 *
 * `rows` is the list as shown (by `sort_order`), without the copy. The reorder route
 * applies the updates one row at a time, and a public page can render between two of them,
 * so they come in an order that never lets one row pass another on the way: the rows whose
 * number falls first, front to back, then the rows whose number rises, back to front. When
 * the original is gone the copy goes last.
 */
export function duplicateChanges(
  rows: readonly Positioned[],
  originalId: string,
  copy: Positioned,
): OrderChange[] {
  const listed = rows.filter((row) => row.id !== copy.id);
  const at = listed.findIndex((row) => row.id === originalId);
  const base =
    at === -1
      ? listed.reduce((max, row) => Math.max(max, row.sort_order), 0)
      : listed[at]!.sort_order;
  const moved = [copy, ...(at === -1 ? [] : listed.slice(at + 1))]
    .map((row, index) => ({
      id: row.id,
      from: row.sort_order,
      sortOrder: base + (index + 1) * ORDER_STEP,
    }))
    .filter((change) => change.from !== change.sortOrder);
  const falling = moved.filter((change) => change.sortOrder < change.from);
  const rising = moved.filter((change) => change.sortOrder > change.from).reverse();
  return [...falling, ...rising].map(({ id, sortOrder }) => ({ id, sortOrder }));
}
