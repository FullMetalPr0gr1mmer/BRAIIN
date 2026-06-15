import { z } from 'zod';
import { anonClient, supabaseConfigured } from '@/lib/supabase/client';

// Public certifications / partnerships (E-E-A-T trust signals). Tier A SSR reads under
// RLS (status='published', tenant-scoped), Zod-validated, resilient.

const LocalizedSchema = z.record(z.string(), z.string());

const CertificationRowSchema = z.object({
  slug: z.string(),
  name: LocalizedSchema,
  issuer: LocalizedSchema.nullable(),
  year: z.number().nullable(),
  logo_url: z.string().nullable(),
  sort_order: z.number(),
});
export type CertificationRow = z.infer<typeof CertificationRowSchema>;

const COLUMNS = 'slug,name,issuer,year,logo_url,sort_order';

export async function getPublishedCertifications(): Promise<CertificationRow[]> {
  if (!supabaseConfigured()) return [];
  try {
    const { data, error } = await anonClient()
      .from('certifications')
      .select(COLUMNS)
      .eq('status', 'published')
      .order('sort_order', { ascending: true });
    if (error || !data) return [];
    return data.flatMap((row) => {
      const parsed = CertificationRowSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    return [];
  }
}
