import type {
  FooterColumnNode,
  FooterNavigation,
  FooterRow,
  NavNode,
  NavRow,
} from '@/lib/data/navigation';

// The menus' rows as trees, pure so they are unit-tested (tests/lib/footerColumns.spec.ts):
// moved out of src/lib/data/navigation.ts (Admin v2 E6), whose exports are the public loaders
// the preview's completeness test counts. `nest` is unchanged.

/** The most columns the footer draws (the database holds the same limit, 0122). */
export const FOOTER_COLUMNS_SHOWN = 4;

/**
 * Flat rows → one level of nesting.
 *
 * An item whose `parent_id` points at something absent (unpublished, or hidden) is
 * promoted to the top level rather than dropped. Losing a link silently is the worse
 * failure: an orphaned child is visible and obviously wrong, whereas a missing one just
 * looks like it was never authored.
 */
export function nest(rows: NavRow[]): NavNode[] {
  const byId = new Map<string, NavNode>();
  for (const row of rows) byId.set(row.id, { ...row, children: [] });

  const roots: NavNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parent_id ? byId.get(node.parent_id) : undefined;
    if (parent && parent.id !== node.id) parent.children.push(node);
    else roots.push(node);
  }
  const bySort = (a: NavNode, b: NavNode) => a.sort_order - b.sort_order;
  roots.sort(bySort);
  for (const node of roots) node.children.sort(bySort);
  return roots;
}

/**
 * The footer's visible rows → columns and loose links. A heading heads a column of the links
 * under it; a link under a link nests one level, as the header's; a link whose parent is
 * absent (hidden, or a heading past the fourth) is promoted to the loose links, never lost. A
 * heading that is not a top-level row, or a link without an address, is dropped (the CHECK
 * makes both impossible; a read never trusts that).
 */
export function footerTree(rows: readonly FooterRow[]): FooterNavigation {
  const bySort = <T extends { sort_order: number }>(a: T, b: T) => a.sort_order - b.sort_order;
  const headings = rows
    .filter((r) => r.is_heading && r.parent_id === null)
    .sort(bySort)
    .slice(0, FOOTER_COLUMNS_SHOWN);
  const columns = new Map<string, FooterColumnNode>(
    headings.map((h) => [h.id, { id: h.id, label: h.label, sort_order: h.sort_order, links: [] }]),
  );
  const linkRows: NavRow[] = rows.flatMap((r) =>
    !r.is_heading && typeof r.href === 'string'
      ? [
          {
            id: r.id,
            parent_id: r.parent_id,
            label: r.label,
            href: r.href,
            sort_order: r.sort_order,
            is_key: r.is_key,
          },
        ]
      : [],
  );
  const loose: NavRow[] = [];
  for (const row of linkRows) {
    const column = row.parent_id ? columns.get(row.parent_id) : undefined;
    if (column) column.links.push({ ...row, children: [] });
    else loose.push(row);
  }
  for (const column of columns.values()) column.links.sort(bySort);
  // Links under a link nest as before; one under a heading not drawn is promoted.
  return { columns: [...columns.values()], links: nest(loose) };
}
