import { z } from 'zod';
import { anonClient, supabaseConfigured } from '@/lib/supabase/client';

// Runtime data access for the Creative Knowledge blog (Tier A SSR). RLS enforces tenant +
// published; we still pass status. Embeds the E-E-A-T author (team_members) + category.
// Zod-validated, resilient: []/null on any error or before Supabase is provisioned.

const LocalizedSchema = z.record(z.string(), z.string());

const AuthorSchema = z
  .object({ slug: z.string(), name: LocalizedSchema, avatar_url: z.string().nullable() })
  .nullable();
const CategorySchema = z.object({ slug: z.string(), name: LocalizedSchema }).nullable();

const PostRowSchema = z.object({
  slug: z.string(),
  title: LocalizedSchema,
  excerpt: LocalizedSchema.nullable(),
  body_html: LocalizedSchema.nullable(),
  cover_image_url: z.string().nullable(),
  published_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  reading_minutes: z.number().nullable(),
  author: AuthorSchema,
  category: CategorySchema,
});
export type PostRow = z.infer<typeof PostRowSchema>;

// PostgREST FK embeds: blog_posts.author_id → team_members, category_id → categories.
const COLUMNS =
  'slug,title,excerpt,body_html,cover_image_url,published_at,updated_at,reading_minutes,' +
  'author:team_members(slug,name,avatar_url),category:categories(slug,name)';

export async function getPublishedPosts(): Promise<PostRow[]> {
  if (!supabaseConfigured()) return [];
  try {
    const { data, error } = await anonClient()
      .from('blog_posts')
      .select(COLUMNS)
      .eq('status', 'published')
      .order('published_at', { ascending: false, nullsFirst: false });
    if (error || !data) return [];
    return data.flatMap((row) => {
      const parsed = PostRowSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    return [];
  }
}

export async function getPostBySlug(slug: string): Promise<PostRow | null> {
  if (!supabaseConfigured()) return null;
  try {
    const { data, error } = await anonClient()
      .from('blog_posts')
      .select(COLUMNS)
      .eq('status', 'published')
      .eq('slug', slug)
      .maybeSingle();
    if (error || !data) return null;
    const parsed = PostRowSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
