import { z } from 'zod';
import { BilingualTextSchema } from '@schemas/primitives';
import { supabaseConfigured } from '@/lib/supabase/client';
import { parseRows } from './parse';
import { contentClient } from './source';

// Public read loader for the CMS-authored navigation (Tier A).
//
// Same posture as every other public loader here: anon key under RLS, validate with
// Zod, and return [] on ANY failure. A nav that throws would take down every page on
// the site — the one component that appears in all of them is the worst possible place
// for a hard dependency on the database being reachable.

export type { BilingualText } from '@schemas/primitives';

const NavRowSchema = z.object({
  id: z.string(),
  parent_id: z.string().nullable(),
  label: BilingualTextSchema,
  href: z.string(),
  sort_order: z.number(),
  // The one link the header keeps visible at <=900px (migration 0019; at most one per
  // location, enforced by a unique partial index).
  is_key: z.boolean(),
});
export type NavRow = z.infer<typeof NavRowSchema>;

export interface NavNode extends NavRow {
  children: NavNode[];
}

const COLUMNS = 'id,parent_id,label,href,sort_order,is_key';

/** Visible items for one location, nested one level deep. */
export async function getNavigation(location: 'header' | 'footer'): Promise<NavNode[]> {
  if (!supabaseConfigured()) return [];
  try {
    const { data, error } = await contentClient()
      .from('navigation')
      .select(COLUMNS)
      .eq('location', location)
      .eq('visible', true)
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true });
    if (error || !data) return [];
    return nest(parseRows(NavRowSchema, data, 'nav_item'));
  } catch {
    return [];
  }
}

/**
 * Flat rows → one level of nesting.
 *
 * An item whose `parent_id` points at something absent (unpublished, or hidden) is
 * promoted to the top level rather than dropped. Losing a link silently is the worse
 * failure: an orphaned child is visible and obviously wrong, whereas a missing one just
 * looks like it was never authored.
 */
function nest(rows: NavRow[]): NavNode[] {
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

// ── The footer (Admin v2 E6) ─────────────────────────────────────────────────────
// The footer's rows may include column headings (navigation.is_heading, 0122): a title over
// the footer links whose parent it is, with no link of its own. Read on their own so the
// header's read (above) is untouched.

const FooterRowSchema = z.object({
  id: z.string(),
  parent_id: z.string().nullable(),
  label: BilingualTextSchema,
  href: z.string().nullable(),
  sort_order: z.number(),
  is_key: z.boolean(),
  is_heading: z.boolean(),
});
type FooterRow = z.infer<typeof FooterRowSchema>;

/** A footer column: its heading's id and title, and the links under it, in order. */
export interface FooterColumnNode {
  id: string;
  label: NavRow['label'];
  sort_order: number;
  links: NavNode[];
}

/** The footer's authored menu: its columns (at most four) and its links outside any column. */
export interface FooterNavigation {
  columns: FooterColumnNode[];
  links: NavNode[];
}

const FOOTER_COLUMNS = 'id,parent_id,label,href,sort_order,is_key,is_heading';

/** The most columns the footer draws (the database holds the same limit, 0122). */
export const FOOTER_COLUMNS_SHOWN = 4;

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

/** The footer's visible rows, as columns and loose links; empty on ANY failure. */
export async function getFooterNavigation(): Promise<FooterNavigation> {
  const none: FooterNavigation = { columns: [], links: [] };
  if (!supabaseConfigured()) return none;
  try {
    const { data, error } = await contentClient()
      .from('navigation')
      .select(FOOTER_COLUMNS)
      .eq('location', 'footer')
      .eq('visible', true)
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true });
    if (error || !data) return none;
    return footerTree(parseRows(FooterRowSchema, data, 'nav_item'));
  } catch {
    return none;
  }
}
