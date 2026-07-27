import { ServiceRowSchema } from '@schemas/content';
import { anonClient, supabaseConfigured } from '@/lib/supabase/client';
import { parseRow, parseRows } from './parse';

// Runtime data access for the public services (Tier A SSR). Tenant + published
// filtering are enforced by RLS; we still pass status explicitly. Shape + validation live
// in `packages/schemas/content.ts` (CLAUDE.md §8 — one schema per shape, shared with the
// admin and Edge Functions). Resilient: returns []/null on any error (e.g. before Supabase
// is provisioned) so builds and the shell never break — pages render an empty state.

export type { ServiceRow } from '@schemas/content';

const COLUMNS =
  'id,slug,title,blurb,body_html,hero_video_uid,category,is_teaser,sort_order,updated_at';

export async function getPublishedServices() {
  if (!supabaseConfigured()) return [];
  try {
    const { data, error } = await anonClient()
      .from('services')
      .select(COLUMNS)
      .eq('status', 'published')
      .order('sort_order', { ascending: true });
    if (error || !data) return [];
    return parseRows(ServiceRowSchema, data, 'service');
  } catch {
    return [];
  }
}

export async function getServiceBySlug(slug: string) {
  if (!supabaseConfigured()) return null;
  try {
    const { data, error } = await anonClient()
      .from('services')
      .select(COLUMNS)
      .eq('status', 'published')
      .eq('slug', slug)
      .maybeSingle();
    if (error || !data) return null;
    return parseRow(ServiceRowSchema, data, 'service');
  } catch {
    return null;
  }
}
