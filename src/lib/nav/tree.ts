import { FOOTER_COLUMNS_MAX } from '@schemas/footerRules';
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
 * under it. A link under a link nests under it, in a column or not (E6 code review, CR1): the
 * footer draws one level of links (SiteFooter draws no `children`, as it never has), so a
 * sub-link is never drawn, and the Footer screen's card says so; before, a column link's
 * sub-link was promoted into the loose row while the card counted it under its link. A link
 * whose parent (or a parent's parent) is absent from the rows is hidden with it: the rows are
 * the visible ones, so its column or its link was hidden, and hiding a column hides its links
 * (the Footer screen's eye, review E6-C1; unlike the header's `nest`, which promotes). A link
 * under a heading that IS read but not drawn (past FOOTER_COLUMNS_MAX) is promoted to the
 * loose links, never lost. A heading that is not a top-level row, or a link without an
 * address, is dropped (the CHECK makes both impossible; a read never trusts that).
 */
export function footerTree(rows: readonly FooterRow[]): FooterNavigation {
  const bySort = <T extends { sort_order: number }>(a: T, b: T) => a.sort_order - b.sort_order;
  const headings = rows
    .filter((r) => r.is_heading && r.parent_id === null)
    .sort(bySort)
    .slice(0, FOOTER_COLUMNS_MAX);
  const columns = new Map<string, FooterColumnNode>(
    headings.map((h) => [h.id, { id: h.id, label: h.label, sort_order: h.sort_order, links: [] }]),
  );
  const links = new Map<string, NavNode>();
  for (const r of rows) {
    if (r.is_heading || typeof r.href !== 'string') continue;
    links.set(r.id, {
      id: r.id,
      parent_id: r.parent_id,
      label: r.label,
      href: r.href,
      sort_order: r.sort_order,
      is_key: r.is_key,
      children: [],
    });
  }
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
  const loose: NavNode[] = [];
  for (const node of links.values()) {
    if (underHidden(node)) continue;
    const parent = node.parent_id;
    const column = parent ? columns.get(parent) : undefined;
    const link = parent ? links.get(parent) : undefined;
    if (column) column.links.push(node);
    else if (link && link.id !== node.id) link.children.push(node);
    // At the top, or under a heading that is not drawn: promoted.
    else loose.push(node);
  }
  for (const column of columns.values()) column.links.sort(bySort);
  for (const node of links.values()) node.children.sort(bySort);
  return { columns: [...columns.values()], links: loose.sort(bySort) };
}
