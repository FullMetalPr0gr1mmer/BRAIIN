import {
  PostDetailRowSchema,
  PostRowSchema,
  type LocalizedProse,
  type PostDetailRow,
  type PostRow,
} from '@schemas/content';
import { supabaseConfigured } from '@/lib/supabase/client';
import { docFromRenderedHtml } from '@/lib/content/renderedHtml';
import { mapRows, parseRow, parseRows } from './parse';
import { renderBody } from './portfolio';
import { contentClient } from './source';

// Runtime data access for the Creative Knowledge blog (Tier A SSR). RLS enforces tenant +
// published; we still pass status. Embeds the E-E-A-T author (team_members) + category.
// Shape lives in `packages/schemas/content.ts` (CLAUDE.md §8). Resilient: []/null on any
// error or before Supabase is provisioned.

export type { PostDetailRow, PostRow } from '@schemas/content';

// PostgREST FK embeds: blog_posts.author_id → team_members, category_id → categories.
const COLUMNS =
  'id,slug,title,excerpt,body_html,cover_image_url,published_at,updated_at,reading_minutes,' +
  'author:team_members(slug,name,avatar_url),category:categories(slug,name)';

/** The post page's select: the list columns and the body's Tiptap source. */
export const POST_DETAIL_COLUMNS = `${COLUMNS},body`;

/**
 * A post as its page renders it: the row without its body's source or its stored cache, which
 * the page never receives, and the body rendered from the source.
 */
export interface PostDetail extends Omit<PostRow, 'body_html'> {
  /** Allowlist-rendered from the Tiptap source on every render (postBodyHtml), never body_html. */
  bodyHtml: LocalizedProse | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The post's body as HTML, rendered HERE by the allowlist renderer on every render (H15, PRE-2),
 * as projects and services render theirs (renderBody, src/lib/data/portfolio.ts). The stored
 * `body_html` cache is not emitted: a staff token can write it straight through PostgREST, and
 * the page used to send it out with set:html, sanitised by nothing.
 *
 * The source is `body`. A post with none (`null`: saved before posts had a source, as the seed's
 * are) holds its words only in the cache, so the cache is read back into a Tiptap document by a
 * strict reader of exactly the renderer's own markup (docFromRenderedHtml) and rendered from
 * that: a cache the renderer wrote renders to the same bytes, and anything else renders nothing.
 * Never throws (renderBody).
 */
export function postBodyHtml(
  row: Pick<PostDetailRow, 'body' | 'body_html'>,
): LocalizedProse | null {
  if (row.body === null || row.body === undefined) {
    const cache = row.body_html;
    if (!cache) return null;
    return renderBody({
      en: docFromRenderedHtml(cache.en),
      ...(cache.ar === undefined ? {} : { ar: docFromRenderedHtml(cache.ar) }),
    });
  }
  return isRecord(row.body) ? renderBody(row.body) : null;
}

/** The page's view of a post row: the row, and its body rendered from the source. */
export function toPostDetail(row: PostDetailRow): PostDetail {
  const { body, body_html, ...post } = row;
  void body; // the source and the cache stay here: the page receives only what was rendered
  void body_html;
  return { ...post, bodyHtml: postBodyHtml(row) };
}

export async function getPublishedPosts() {
  if (!supabaseConfigured()) return [];
  try {
    const { data, error } = await contentClient()
      .from('blog_posts')
      .select(COLUMNS)
      .eq('status', 'published')
      .order('published_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: true });
    if (error || !data) return [];
    return parseRows(PostRowSchema, data, 'blog_post');
  } catch {
    return [];
  }
}

/** One published post as its page renders it, or null (the page answers a real 404). */
export async function getPostBySlug(slug: string): Promise<PostDetail | null> {
  if (!supabaseConfigured()) return null;
  try {
    const { data, error } = await contentClient()
      .from('blog_posts')
      .select(POST_DETAIL_COLUMNS)
      .eq('status', 'published')
      .eq('slug', slug)
      .maybeSingle();
    if (error || !data) return null;
    const row = parseRow(PostDetailRowSchema, data, 'blog_post');
    // Mapped inside its own guard (H15, mapRows): a row that cannot be mapped is a logged 404.
    return row ? (mapRows([row], toPostDetail, 'blog_post')[0] ?? null) : null;
  } catch {
    return null;
  }
}
