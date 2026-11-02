import {
  PostDetailRowSchema,
  PostRowSchema,
  type PostDetailRow,
  type PostRow,
} from '@schemas/content';
import type { Locale } from '@schemas/primitives';
import { supabaseConfigured } from '@/lib/supabase/client';
import { renderArticle } from '@/lib/content/tiptap';
import { docFromRenderedHtml } from '@/lib/content/renderedHtml';
import { parseRow, parseRows, reportBodyRefused } from './parse';
import { renderStoredDoc } from './portfolio';
import { contentClient } from './source';

// Runtime data access for the Creative Knowledge blog (Tier A SSR). RLS enforces tenant +
// published; we still pass status. Embeds the E-E-A-T author (team_members) + category.
// Shape lives in `packages/schemas/content.ts` (CLAUDE.md §8). Resilient: []/null on any
// error or before Supabase is provisioned.

export type { PostDetailRow, PostRow } from '@schemas/content';

// PostgREST FK embeds: blog_posts.author_id → team_members, category_id → categories. No body:
// the list, the sitemap, llms.txt and the feeds show none (H15 code review, CR4).
const COLUMNS =
  'id,slug,title,excerpt,cover_image_url,published_at,updated_at,reading_minutes,' +
  'author:team_members(slug,name,avatar_url),category:categories(slug,name)';

/**
 * The post page's select: the list columns, the stored cache and the body's Tiptap source. Both
 * in the one read (H15 code review, CR4): a post with no source (production's published posts
 * today) and a source the renderer refuses (CR5) are rendered from the cache, so reading it only
 * when needed would be a second round trip on exactly those posts.
 */
export const POST_DETAIL_COLUMNS = `${COLUMNS},body_html,body`;

/**
 * A post as its page renders it: the row, without its body's source or its stored cache, which
 * the page never receives, and the body rendered in the language served.
 */
export interface PostDetail extends PostRow {
  /**
   * The body in the language the page serves (the English one when the Arabic renders nothing,
   * as pickLocale reads a pair), allowlist-rendered on every render (postBodyHtml), never
   * body_html as stored; null for no body.
   */
  bodyHtml: string | null;
}

const ENTITY = 'blog_post';

/** What is logged for a stored cache the strict reader refuses (no content, CR1). */
const CACHE_UNREADABLE = 'its stored HTML is not the renderer’s markup';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

type BodyRow = Pick<PostDetailRow, 'id' | 'body' | 'body_html'>;

/** One language of the cache, read back into a document and rendered; '' for none. */
function cacheLanguage(row: BodyRow, lang: Locale): string {
  const cache = isRecord(row.body_html) ? row.body_html[lang] : undefined;
  if (cache === undefined || cache === null || cache === '') return '';
  const doc = docFromRenderedHtml(cache);
  if (doc === null) {
    reportBodyRefused(ENTITY, row.id, lang, CACHE_UNREADABLE);
    return '';
  }
  return renderStoredDoc(doc, lang, { entity: ENTITY, id: row.id });
}

/**
 * One language of the body: from the source when the post has one, else from the cache read
 * back. A source the renderer refuses is logged and the cache is read back in its place (H15 code
 * review, CR5): a body saved through the API has a cache the renderer wrote from it, so a body a
 * later cap refuses still shows the words it was saved with. The cache goes through the same
 * strict reader and renderer either way, so nothing of it reaches the page as stored.
 */
function bodyLanguage(row: BodyRow, lang: Locale): string {
  const { body } = row;
  if (body === null || body === undefined) return cacheLanguage(row, lang);
  if (!isRecord(body)) {
    reportBodyRefused(ENTITY, row.id, lang, 'the source is not a pair of languages');
    return cacheLanguage(row, lang);
  }
  const doc = body[lang];
  if (doc === undefined || doc === null) return '';
  const { html, refused } = renderArticle(doc);
  if (refused === null) return html;
  reportBodyRefused(ENTITY, row.id, lang, refused);
  return cacheLanguage(row, lang);
}

/**
 * The post's body as HTML in the language served, rendered HERE by the allowlist renderer on
 * every render (H15, PRE-2), as projects and services render theirs (renderBody,
 * src/lib/data/portfolio.ts). The stored `body_html` cache is not emitted: a staff token can
 * write it straight through PostgREST, and the page used to send it out with set:html,
 * sanitised by nothing.
 *
 * The source is `body`. A post with none (`null`: saved before posts had a source, as the seed's
 * are) holds its words only in the cache, so the cache is read back into a Tiptap document by a
 * strict reader of exactly the renderer's own markup (docFromRenderedHtml) and rendered from
 * that: a cache the renderer wrote renders to the same bytes, and anything else renders nothing
 * (and is logged, CR1). A source the renderer refuses falls back to the cache the same way (CR5).
 *
 * Only the language served is rendered (CR2): the page shows one. An Arabic page whose Arabic
 * body renders nothing renders the English one, the fallback pickLocale gave the pair before.
 *
 * Never throws: everything runs inside this function's own try (H15 review, COR-5: a cache that
 * made the read-back throw turned the post into a 404 while the blog list, the sitemap and
 * llms.txt still listed it), so a body that cannot be read is no body, logged, and the post
 * renders.
 */
export function postBodyHtml(row: BodyRow, locale: Locale): string | null {
  try {
    const html = bodyLanguage(row, locale) || (locale === 'ar' ? bodyLanguage(row, 'en') : '');
    return html || null;
  } catch (err) {
    reportBodyRefused(ENTITY, row.id, locale, err instanceof Error ? err.name : 'unknown');
    return null;
  }
}

/** The page's view of a post row: the row, and its body rendered in the language served. */
export function toPostDetail(row: PostDetailRow, locale: Locale): PostDetail {
  const { body, body_html, ...post } = row;
  void body; // the source and the cache stay here: the page receives only what was rendered
  void body_html;
  return { ...post, bodyHtml: postBodyHtml(row, locale) };
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

/**
 * One published post as its page renders it in `locale`, or null (the page answers a real 404).
 * toPostDetail cannot throw (postBodyHtml is its own guard), so the row is mapped as it is.
 */
export async function getPostBySlug(slug: string, locale: Locale): Promise<PostDetail | null> {
  if (!supabaseConfigured()) return null;
  try {
    const { data, error } = await contentClient()
      .from('blog_posts')
      .select(POST_DETAIL_COLUMNS)
      .eq('status', 'published')
      .eq('slug', slug)
      .maybeSingle();
    if (error || !data) return null;
    const row = parseRow(PostDetailRowSchema, data, ENTITY);
    return row ? toPostDetail(row, locale) : null;
  } catch {
    return null;
  }
}
