import { TeamMemberRowSchema } from '@schemas/content';
import { anonClient, supabaseConfigured } from '@/lib/supabase/client';
import { parseRows } from './parse';

// Public team members = E-E-A-T authors (CLAUDE.md Pillar 3 — no anonymous authorship).
// Tier A SSR reads under RLS (status='published', tenant-scoped). Shape lives in
// `packages/schemas/content.ts` (CLAUDE.md §8). Resilient: [] on any error.

export type { TeamMemberRow } from '@schemas/content';

const COLUMNS = 'slug,name,bio,avatar_url,sort_order';

export async function getPublishedTeam() {
  if (!supabaseConfigured()) return [];
  try {
    const { data, error } = await anonClient()
      .from('team_members')
      .select(COLUMNS)
      .eq('status', 'published')
      .order('sort_order', { ascending: true });
    if (error || !data) return [];
    return parseRows(TeamMemberRowSchema, data, 'team_member');
  } catch {
    return [];
  }
}
