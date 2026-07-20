import { CertificationRowSchema } from '@schemas/content';
import { anonClient, supabaseConfigured } from '@/lib/supabase/client';
import { parseRows } from './parse';

// Public certifications / partnerships (E-E-A-T trust signals). Tier A SSR reads under
// RLS (status='published', tenant-scoped). Shape lives in `packages/schemas/content.ts`
// (CLAUDE.md §8). Resilient: [] on any error.

export type { CertificationRow } from '@schemas/content';

const COLUMNS = 'slug,name,issuer,year,logo_url,sort_order';

export async function getPublishedCertifications() {
  if (!supabaseConfigured()) return [];
  try {
    const { data, error } = await anonClient()
      .from('certifications')
      .select(COLUMNS)
      .eq('status', 'published')
      .order('sort_order', { ascending: true });
    if (error || !data) return [];
    return parseRows(CertificationRowSchema, data, 'certification');
  } catch {
    return [];
  }
}
