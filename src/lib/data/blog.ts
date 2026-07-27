import { PostRowSchema } from '@schemas/content';
import { anonClient, supabaseConfigured } from '@/lib/supabase/client';
import { parseRow, parseRows } from './parse';

// Runtime data access for the Creative Knowledge blog (Tier A SSR). RLS enforces tenant +
// published; we still pass status. Embeds the E-E-A-T author (team_members) + category.
// Shape lives in `packages/schemas/content.ts` (CLAUDE.md §8). Resilient: []/null on any
// error or before Supabase is provisioned.

export type { PostRow } from '@schemas/content';

// PostgREST FK embeds: blog_posts.author_id → team_members, category_id → categories.
const COLUMNS =
  'id,slug,title,excerpt,body_html,cover_image_url,published_at,updated_at,reading_minutes,' +
  'author:team_members(slug,name,avatar_url),category:categories(slug,name)';

export async function getPublishedPosts() {
  if (!supabaseConfigured()) return [];
  try {
    const { data, error } = await anonClient()
      .from('blog_posts')
      .select(COLUMNS)
      .eq('status', 'published')
      .order('published_at', { ascending: false, nullsFirst: false });
    if (error || !data) return [];
    return parseRows(PostRowSchema, data, 'blog_post');
  } catch {
    return [];
  }
}

export async function getPostBySlug(slug: string) {
  if (!supabaseConfigured()) return null;
  try {
    const { data, error } = await anonClient()
      .from('blog_posts')
      .select(COLUMNS)
      .eq('status', 'published')
      .eq('slug', slug)
      .maybeSingle();
    if (error || !data) return null;
    return parseRow(PostRowSchema, data, 'blog_post');
  } catch {
    return null;
  }
}
