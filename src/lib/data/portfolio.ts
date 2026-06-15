import { z } from 'zod';
import { anonClient, supabaseConfigured } from '@/lib/supabase/client';

// Runtime data access for the public portfolio / case studies (Tier A SSR). Tenant +
// published filtering are enforced by RLS; we still pass status explicitly. Zod-validated.
// Resilient: returns []/null on any error (e.g. before Supabase is provisioned) so
// builds and the shell never break — pages render an empty state.

const LocalizedSchema = z.record(z.string(), z.string());

const PortfolioRowSchema = z.object({
  slug: z.string(),
  title: LocalizedSchema,
  summary: LocalizedSchema.nullable(),
  body_html: LocalizedSchema.nullable(),
  sort_order: z.number(),
});
export type PortfolioRow = z.infer<typeof PortfolioRowSchema>;

const COLUMNS = 'slug,title,summary,body_html,sort_order';

export async function getPublishedPortfolio(): Promise<PortfolioRow[]> {
  if (!supabaseConfigured()) return [];
  try {
    const { data, error } = await anonClient()
      .from('portfolio')
      .select(COLUMNS)
      .eq('status', 'published')
      .order('sort_order', { ascending: true });
    if (error || !data) return [];
    return data.flatMap((row) => {
      const parsed = PortfolioRowSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    return [];
  }
}

export async function getPortfolioBySlug(slug: string): Promise<PortfolioRow | null> {
  if (!supabaseConfigured()) return null;
  try {
    const { data, error } = await anonClient()
      .from('portfolio')
      .select(COLUMNS)
      .eq('status', 'published')
      .eq('slug', slug)
      .maybeSingle();
    if (error || !data) return null;
    const parsed = PortfolioRowSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
