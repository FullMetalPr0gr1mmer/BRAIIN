import { z } from 'zod';
import { anonClient, supabaseConfigured } from '@/lib/supabase/client';

// Public team members = E-E-A-T authors (CLAUDE.md Pillar 3 — no anonymous authorship).
// Tier A SSR reads under RLS (status='published', tenant-scoped), Zod-validated, resilient.

const LocalizedSchema = z.record(z.string(), z.string());

const TeamMemberRowSchema = z.object({
  slug: z.string(),
  name: LocalizedSchema,
  bio: LocalizedSchema.nullable(),
  avatar_url: z.string().nullable(),
  sort_order: z.number(),
});
export type TeamMemberRow = z.infer<typeof TeamMemberRowSchema>;

const COLUMNS = 'slug,name,bio,avatar_url,sort_order';

export async function getPublishedTeam(): Promise<TeamMemberRow[]> {
  if (!supabaseConfigured()) return [];
  try {
    const { data, error } = await anonClient()
      .from('team_members')
      .select(COLUMNS)
      .eq('status', 'published')
      .order('sort_order', { ascending: true });
    if (error || !data) return [];
    return data.flatMap((row) => {
      const parsed = TeamMemberRowSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    return [];
  }
}
