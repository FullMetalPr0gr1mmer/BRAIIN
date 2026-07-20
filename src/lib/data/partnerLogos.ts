import { PartnerLogoRowSchema } from '@schemas/content';
import { anonClient, supabaseConfigured } from '@/lib/supabase/client';
import { parseRows } from './parse';

// Public partner/client logos for the home "trusted by" marquee. Tier A SSR read under
// RLS (tenant-scoped; partner_logos has no publish lifecycle — visibility is the `visible`
// flag). Shape lives in `packages/schemas/content.ts` (CLAUDE.md §8). Resilient: [].

export type { PartnerLogoRow } from '@schemas/content';

const COLUMNS = 'name,logo_url,sort_order';

export async function getPartnerLogos() {
  if (!supabaseConfigured()) return [];
  try {
    const { data, error } = await anonClient()
      .from('partner_logos')
      .select(COLUMNS)
      .eq('visible', true)
      .order('sort_order', { ascending: true });
    if (error || !data) return [];
    return parseRows(PartnerLogoRowSchema, data, 'partner_logo');
  } catch {
    return [];
  }
}
