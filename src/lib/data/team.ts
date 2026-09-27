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
  'slug,name,bio,avatar_url,sort_order,role,linkedin_url,is_leadership,is_placeholder,' +
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
  /** A seeded placeholder: its card may show (0027 override), but it is never a Person node. */
  isPlaceholder: boolean;
}

/**
 * The shape 0023 CHECKs and the admin validates. Checked again here because the URL
 * renders into an <a href> on a public page: a row that slipped past both (a hand edit)
 * shows the card without a link rather than an arbitrary URL.
 */
const LINKEDIN_URL = /^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/(in|company)\/[A-Za-z0-9_-]+\/?$/;

/** A published team row → a leadership card. */
export function toLeader(m: TeamMemberRow): Leader {
  const url = m.linkedin_url?.trim() ?? '';
  return {
    slug: m.slug,
    name: m.name,
    role: m.role,
    linkedinUrl: LINKEDIN_URL.test(url) ? url : null,
    portrait: imageRef(m.portrait),
    isPlaceholder: m.is_placeholder,
  };
}

/** The leadership slider, in order. */
export async function getLeadership(): Promise<Leader[]> {
  return (await load(true)).map(toLeader);
}
