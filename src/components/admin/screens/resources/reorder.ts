// Move up and Move down on a resource list (ResourceTable; Admin v2 hotfix H12), pure so it is
// unit-tested (tests/lib/resourceReorder.spec.ts).
//
// A move swaps two rows' `sort_order`, and the reorder route writes both rows. An archived row
// is written by an Admin only: the RESTRICTIVE archive gates (0001, 0007, 0018, 0021, 0028:
// `with check (app.is_admin() or status <> 'archived')`) refuse any update that leaves a row
// archived, a new sort order included. So for a person who may not archive (`canArchive`:
// content.archiveDelete, Admin only, CLAUDE.md §5) a move passes over archived rows to the
// nearest row that is not archived, an archived row does not move at all, and a button with no
// row to swap with is disabled. An archived row has no place on the site, so stepping over it
// changes nothing a visitor sees. An Admin's move swaps with the next row, archived or not, as
// it always did. The route refuses a move that names an archived row either way (resource.ts).

/** Whether this person's move may write the row: anyone's, unless the row is archived. */
export function movable(row: Readonly<Record<string, unknown>>, canArchive: boolean): boolean {
  return canArchive || row['status'] !== 'archived';
}

/**
 * The index of the row that a move of `rows[index]` one step in `direction` swaps with: the
 * nearest row that way this person may write. Null when there is none (the row is the first or
 * the last on the page, only archived rows lie that way, or the row itself is archived), which
 * is when its button is disabled. A row with no `status` (clients, sectors) is never archived.
 */
export function swapTarget(
  rows: readonly Readonly<Record<string, unknown>>[],
  index: number,
  direction: -1 | 1,
  canArchive: boolean,
): number | null {
  const row = rows[index];
  if (!row || !movable(row, canArchive)) return null;
  for (let at = index + direction; at >= 0 && at < rows.length; at += direction) {
    if (movable(rows[at]!, canArchive)) return at;
  }
  return null;
}
