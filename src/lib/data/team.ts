import {
  PUBLIC_MEDIA_COLUMNS,
  TeamMemberRowSchema,
  type LocalizedText,
  type TeamMemberRow,
} from '@schemas/content';
import { anonClient, supabaseConfigured } from '@/lib/supabase/client';
import { imageRef, type ImageRef } from '@/lib/media/resolve';
import { parseRows, reportLoadError } from './parse';

// Public team members = E-E-A-T authors (CLAUDE.md Pillar 3 — no anonymous authorship)
// and, filtered by `is_leadership`, the About leadership slider. Tier A SSR reads under RLS
// (status='published', tenant-scoped). Shape lives in `packages/schemas/content.ts`
// (CLAUDE.md §8). Resilient: [] on any error.

export type { TeamMemberRow } from '@schemas/content';

const COLUMNS =
  'slug,name,bio,avatar_url,sort_order,role,linkedin_url,is_leadership,' +
  `portrait:portrait_media_id(${PUBLIC_MEDIA_COLUMNS})`;

async function load(leadershipOnly: boolean): Promise<TeamMemberRow[]> {
  if (!supabaseConfigured()) return [];
  try {
    let query = anonClient()
      .from('team_members')
      .select(COLUMNS)
      .eq('status', 'published')
      .order('sort_order', { ascending: true });
    if (leadershipOnly) query = query.eq('is_leadership', true);
    const { data, error } = await query;
    if (error) {
      reportLoadError('team_members', error);
      return [];
    }
    return parseRows(TeamMemberRowSchema, data ?? [], 'team_member');
  } catch (err) {
    reportLoadError('team_members', err);
    return [];
  }
}

export async function getPublishedTeam(): Promise<TeamMemberRow[]> {
  return load(false);
}

export interface Leader {
  slug: string;
  name: LocalizedText;
  role: LocalizedText | null;
  linkedinUrl: string | null;
  portrait: ImageRef | null;
}

/** The leadership slider, in order. */
export async function getLeadership(): Promise<Leader[]> {
  return (await load(true)).map((m) => ({
    slug: m.slug,
    name: m.name,
    role: m.role,
    linkedinUrl: m.linkedin_url,
    portrait: imageRef(m.portrait),
  }));
}
