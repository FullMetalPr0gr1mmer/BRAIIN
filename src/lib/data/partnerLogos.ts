import { z } from 'zod';
import { anonClient, supabaseConfigured } from '@/lib/supabase/client';

// Public partner/client logos for the home "trusted by" marquee. Tier A SSR read under
// RLS (tenant-scoped; partner_logos has no publish lifecycle — visibility is the `visible`
// flag). Zod-validated, resilient: returns [] on any error or before Supabase exists.

const PartnerLogoRowSchema = z.object({
  name: z.string(),
  logo_url: z.string(),
  sort_order: z.number(),
});
export type PartnerLogoRow = z.infer<typeof PartnerLogoRowSchema>;

const COLUMNS = 'name,logo_url,sort_order';

export async function getPartnerLogos(): Promise<PartnerLogoRow[]> {
  if (!supabaseConfigured()) return [];
  try {
    const { data, error } = await anonClient()
      .from('partner_logos')
      .select(COLUMNS)
      .eq('visible', true)
      .order('sort_order', { ascending: true });
    if (error || !data) return [];
    return data.flatMap((row) => {
      const parsed = PartnerLogoRowSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    return [];
  }
}
