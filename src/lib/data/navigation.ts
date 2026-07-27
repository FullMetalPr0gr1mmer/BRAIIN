import { z } from 'zod';
import { BilingualTextSchema } from '@schemas/primitives';
import { anonClient, supabaseConfigured } from '@/lib/supabase/client';
import { parseRows } from './parse';

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
});
export type NavRow = z.infer<typeof NavRowSchema>;

export interface NavNode extends NavRow {
  children: NavNode[];
}

const COLUMNS = 'id,parent_id,label,href,sort_order';

/** Visible items for one location, nested one level deep. */
export async function getNavigation(location: 'header' | 'footer'): Promise<NavNode[]> {
  if (!supabaseConfigured()) return [];
  try {
    const { data, error } = await anonClient()
      .from('navigation')
      .select(COLUMNS)
      .eq('location', location)
      .eq('visible', true)
      .order('sort_order', { ascending: true });
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
