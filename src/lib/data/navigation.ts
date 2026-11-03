import { z } from 'zod';
import { BilingualTextSchema } from '@schemas/primitives';
import { supabaseConfigured } from '@/lib/supabase/client';
import { parseRows } from './parse';
import { footerTree, nest } from '@/lib/nav/tree';
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
export type FooterRow = z.infer<typeof FooterRowSchema>;

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
