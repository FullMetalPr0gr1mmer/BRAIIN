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
 * under it; a link under a link nests one level, as the header's. A link whose parent (or a
 * parent's parent) is absent from the rows is hidden with it: the rows are the visible ones,
 * so its column or its link was hidden, and hiding a column hides its links (the Footer
 * screen's eye, review E6-C1; unlike the header's `nest`, which promotes). A link under a
 * heading that IS read but not drawn (past the fourth) is promoted to the loose links, never
 * lost. A heading that is not a top-level row, or a link without an address, is dropped (the
 * CHECK makes both impossible; a read never trusts that).
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
  const byId = new Map(rows.map((r) => [r.id, r]));
  // True when a parent up the chain is not among the rows (hidden). A cycle stops the walk.
  const underHidden = (row: NavRow): boolean => {
    const seen = new Set<string>([row.id]);
    for (let parent = row.parent_id; parent !== null;) {
      const up = byId.get(parent);
      if (!up) return true;
      if (seen.has(up.id)) return false;
      seen.add(up.id);
      parent = up.parent_id;
    }
    return false;
  };
  const loose: NavRow[] = [];
  for (const row of linkRows) {
    if (underHidden(row)) continue;
    const column = row.parent_id ? columns.get(row.parent_id) : undefined;
    if (column) column.links.push({ ...row, children: [] });
    else loose.push(row);
  }
  for (const column of columns.values()) column.links.sort(bySort);
  // Links under a link nest as before; one under a heading not drawn is promoted.
  return { columns: [...columns.values()], links: nest(loose) };
}
