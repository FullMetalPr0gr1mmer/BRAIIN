import { useEffect, useRef, type ReactNode } from 'react';
import EmptyState from './EmptyState';
import Pager from './Pager';
import type { IconName } from '@/lib/admin/icons';
import { pageInfo, rangeText, PAGE_SIZE } from '@/lib/admin/pager';

// The admin's data table (Admin v2 F4b, docs/admin-v2/ui.md §2.4, the prototype's .tbl):
// one page of a server-paged list, for islands. What it guarantees, so screens do not each
// re-solve it:
//   - Paging: 25 rows a page from the server (`total`, `offset`, `onPage`), numbered pages
//     with the current one aria-current, and "26 to 50 of 112" in a live region.
//   - The row's link: the title column holds a real link to the row's page, stretched
//     over the row (admin.css); there is no click handler on the row, so the link works
//     with every input and opens in a new tab like any link.
//   - Row actions: shown on hover AND whenever focus is inside the row (WCAG 2.4.7), and
//     always on a device that cannot hover.
//   - Selection (opt-in): a "Select <name>" checkbox per row, a tri-state "Select all on
//     this page", the count announced, and a midnight bulk bar with the caller's actions.
//     A selection is the page's: the bar counts and acts on the ticked rows on screen
//     only, and a new page clears it (a new filter or search keeps only the ticked rows
//     still shown), so a bulk action never reaches a row the person cannot see.
//   - Numbers: a `num` column is tabular and end-aligned.
//   - States: a loading row, an empty state that says what to do, an inline error (never
//     a toast, ui.md §2.3).
//   - A page that comes back empty while rows remain (its last row was deleted, here or by
//     someone else) steps back to the last page that has rows (`settleOffset`); the empty
//     state is for a list with no rows at all, never for a page past the end.
// The toolbar (search, chips, a segmented control) is the caller's, passed as `toolbar`.

export interface DataColumn<Row> {
  key: string;
  label: string;
  /** Tabular and end-aligned. */
  num?: boolean;
  /** The cell's content. In the title column it follows the link (a second line). */
  render?: ((row: Row) => ReactNode) | undefined;
}

export interface DataSelection {
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  /** The bulk bar's actions, given the ticked rows on this page (never rows off screen). */
  actions: (ids: string[]) => ReactNode;
}

export interface DataTableProps<Row extends { id: string }> {
  /** The table's name, for assistive technology (a visually hidden <caption>). */
  caption: string;
  columns: readonly DataColumn<Row>[];
  rows: readonly Row[];
  /** Names a row: its link's text and its checkbox's label ("Select Logo design"). */
  rowName: (row: Row) => string;
  /** The row's page; the title column links to it. */
  rowHref?: ((row: Row) => string) | undefined;
  /** The column that holds the link: the first by default. */
  titleColumn?: string | undefined;
  total: number;
  offset: number;
  limit?: number;
  onPage: (offset: number) => void;
  rowActions?: ((row: Row, index: number) => ReactNode) | undefined;
  /** Heading of the actions column, read by assistive technology only. */
  actionsLabel?: string;
  selection?: DataSelection | undefined;
  toolbar?: ReactNode;
  busy?: boolean;
  error?: string | undefined;
  empty?: { title: string; text?: string; icon?: IconName; action?: ReactNode } | undefined;
}

/**
 * Where a list goes when its page came back empty but rows remain: the last page that has
 * rows. Null when the page is fine (it shows rows, or the list is empty, or it is already
 * the last page). Without it, deleting the one row on the last page left an empty table
 * that read "No services yet" over "1 to 25 of 25", with no pager to step back.
 */
export function settleOffset(
  shown: number,
  total: number,
  offset: number,
  limit = PAGE_SIZE,
): number | null {
  if (shown > 0 || total <= 0) return null;
  const last = pageInfo(total, offset, limit).offset;
  return last === offset ? null : last;
}

/**
 * The ticked rows of this page, in its order: what the bulk bar counts and hands to its
 * actions. An id in the set that is not on screen (another page, filtered out, deleted)
 * is never counted or acted on.
 */
export function pageSelection(selected: ReadonlySet<string>, rows: readonly { id: string }[]) {
  return rows.filter((row) => selected.has(row.id)).map((row) => row.id);
}

/** A cell's value as text, when the column has no renderer. */
function plain(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

export default function DataTable<Row extends { id: string }>({
  caption,
  columns,
  rows,
  rowName,
  rowHref,
  titleColumn,
  total,
  offset,
  limit = PAGE_SIZE,
  onPage,
  rowActions,
  actionsLabel = 'Actions',
  selection,
  toolbar,
  busy = false,
  error,
  empty = { title: 'Nothing here yet' },
}: DataTableProps<Row>) {
  const info = pageInfo(total, offset, limit);
  // A page past the end steps back (the parent's onPage loads it); until it has, the table
  // says it is loading, not that nothing exists.
  const settle = busy ? null : settleOffset(rows.length, total, offset, limit);
  const loading = busy || settle !== null;
  const page = useRef(onPage);
  page.current = onPage;
  useEffect(() => {
    if (settle !== null) page.current(settle);
  }, [settle]);
  const linkColumn = titleColumn ?? columns[0]?.key;
  const span = columns.length + (selection ? 1 : 0) + (rowActions ? 1 : 0);
  const chosen = selection ? pageSelection(selection.selected, rows) : [];
  const all = rows.length > 0 && chosen.length === rows.length;
  const some = chosen.length > 0 && !all;

  // The selection follows the page: moving to another page clears it, and new rows (a
  // filter, a search, a delete) keep only the ticked ones still shown. Going back to a
  // page never finds old ticks, and the parent's set never holds an id off screen.
  const select = useRef(selection);
  select.current = selection;
  const shownOffset = useRef(offset);
  // The rows are compared by their ids: a new array holding the same rows is the same page.
  const rowKey = rows.map((row) => row.id).join(' ');
  useEffect(() => {
    const moved = shownOffset.current !== offset;
    shownOffset.current = offset;
    const current = select.current;
    if (!current || current.selected.size === 0) return;
    const kept = moved ? [] : pageSelection(current.selected, rows);
    if (kept.length !== current.selected.size) current.onChange(new Set(kept));
  }, [offset, rowKey]);

  // "Select all on this page" is tri-state: `indeterminate` is a DOM property with no
  // attribute, so it is set after render (the server's HTML shows the box unticked).
  const allBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (allBox.current) allBox.current.indeterminate = some;
  }, [some]);

  function toggle(id: string, on: boolean) {
    if (!selection) return;
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    selection.onChange(next);
  }

  function toggleAll(on: boolean) {
    if (!selection) return;
    selection.onChange(new Set(on ? rows.map((row) => row.id) : []));
  }

  const count = chosen.length;

  return (
    <>
      {toolbar && <div className="toolbar">{toolbar}</div>}
      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}
      <div className="card card--flush dt">
        <div className="table-wrap">
          <table className="data" aria-busy={loading || undefined}>
            <caption className="visually-hidden">{caption}</caption>
            <thead>
              <tr>
                {selection && (
                  <th scope="col" className="data-sel">
                    <input
                      ref={allBox}
                      type="checkbox"
                      aria-label="Select all on this page"
                      checked={all}
                      disabled={rows.length === 0}
                      onChange={(event) => toggleAll(event.target.checked)}
                    />
                  </th>
                )}
                {columns.map((column) => (
                  <th key={column.key} scope="col" className={column.num ? 'num' : undefined}>
                    {column.label}
                  </th>
                ))}
                {rowActions && (
                  <th scope="col">
                    <span className="visually-hidden">{actionsLabel}</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const on = selection?.selected.has(row.id) ?? false;
                return (
                  <tr key={row.id} data-selected={on ? '' : undefined}>
                    {selection && (
                      <td className="data-sel">
                        <input
                          type="checkbox"
                          aria-label={`Select ${rowName(row)}`}
                          checked={on}
                          onChange={(event) => toggle(row.id, event.target.checked)}
                        />
                      </td>
                    )}
                    {columns.map((column) => (
                      <td key={column.key} className={column.num ? 'num' : undefined}>
                        {column.key === linkColumn && rowHref ? (
                          <>
                            <a className="data-link" href={rowHref(row)} dir="auto">
                              {rowName(row)}
                            </a>
                            {column.render?.(row)}
                          </>
                        ) : column.render ? (
                          column.render(row)
                        ) : (
                          plain((row as Record<string, unknown>)[column.key])
                        )}
                      </td>
                    ))}
                    {rowActions && (
                      <td>
                        <div className="row-acts">{rowActions(row, index)}</div>
                      </td>
                    )}
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={span}>
                    {loading ? (
                      <p className="empty__x">Loading…</p>
                    ) : (
                      <EmptyState
                        title={empty.title}
                        text={empty.text}
                        icon={empty.icon ?? 'inbox'}
                      >
                        {empty.action}
                      </EmptyState>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="tbl__foot">
          <p className="tbl__range" aria-live="polite">
            {loading && rows.length === 0 ? '' : rangeText(info)}
          </p>
          <Pager info={info} onPage={onPage} />
        </div>
      </div>
      {selection && (
        <>
          <p className="visually-hidden" aria-live="polite">
            {count > 0 ? `${count} selected` : ''}
          </p>
          {count > 0 && (
            <BulkBar count={count} onClear={() => selection.onChange(new Set())}>
              {selection.actions(chosen)}
            </BulkBar>
          )}
        </>
      )}
    </>
  );
}

export interface BulkBarProps {
  count: number;
  onClear: () => void;
  children: ReactNode;
}

/**
 * The bulk bar (the prototype's midnight bar): how many rows are chosen, the actions for
 * them, and a way to clear the choice. A region, so it can be found by landmark; the
 * count is announced by the table's own live region, which exists before the bar does.
 */
export function BulkBar({ count, onClear, children }: BulkBarProps) {
  return (
    <div className="bulkbar" role="region" aria-label="Bulk actions">
      <p className="bulkbar__n">{count === 1 ? '1 selected' : `${count} selected`}</p>
      {children}
      <button type="button" data-variant="ghost" onClick={onClear}>
        Clear selection
      </button>
    </div>
  );
}
