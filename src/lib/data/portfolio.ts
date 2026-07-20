import { PortfolioRowSchema } from '@schemas/content';
import { anonClient, supabaseConfigured } from '@/lib/supabase/client';
import { parseRow, parseRows } from './parse';

// Runtime data access for the public portfolio / case studies (Tier A SSR). Tenant +
// published filtering are enforced by RLS; we still pass status explicitly. Shape lives in
// `packages/schemas/content.ts` (CLAUDE.md §8). Resilient: []/null on any error.

export type { PortfolioRow } from '@schemas/content';

const COLUMNS = 'slug,title,summary,body_html,sort_order,updated_at';

export async function getPublishedPortfolio() {
  if (!supabaseConfigured()) return [];
  try {
    const { data, error } = await anonClient()
      .from('portfolio')
      .select(COLUMNS)
      .eq('status', 'published')
      .order('sort_order', { ascending: true });
    if (error || !data) return [];
    return parseRows(PortfolioRowSchema, data, 'portfolio');
  } catch {
    return [];
  }
}

export async function getPortfolioBySlug(slug: string) {
  if (!supabaseConfigured()) return null;
  try {
    const { data, error } = await anonClient()
      .from('portfolio')
      .select(COLUMNS)
      .eq('status', 'published')
      .eq('slug', slug)
      .maybeSingle();
    if (error || !data) return null;
    return parseRow(PortfolioRowSchema, data, 'portfolio');
  } catch {
    return null;
  }
}
