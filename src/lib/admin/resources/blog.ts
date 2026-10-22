import type { LocalizedDoc } from '@schemas/tiptap';
import { PostUpdateSchema, PostWriteSchema } from '@schemas/admin';
import { readingMinutes } from '@/lib/content/tiptap';
import { ValidationError } from '../errors';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { liveDb, type OverlayDb } from '@/lib/release/overlayDb';
import type { ResourceConfig } from '../resource';
import {
  STAMPED,
  fieldsOf,
  pick,
  publishStamp,
  requireBilingual,
  statusOf,
  withBodyHtml,
  type Input,
} from './shared';

// Blog posts (Creative Knowledge).

const POST_KEYS = {
  slug: 'slug',
  title: 'title',
  excerpt: 'excerpt',
  body: 'body',
  authorId: 'author_id',
  categoryId: 'category_id',
  coverImageUrl: 'cover_image_url',
  status: 'status',
  scheduledFor: 'scheduled_for',
};

export const postResource: ResourceConfig = {
  table: 'blog_posts',
  entity: 'blog_post',
  writeCap: 'blog.write',
  readCaps: ['blog.write', 'seo.entityMeta'],
  listColumns: 'id,slug,title,status,published_at,scheduled_for,version,updated_at',
  columns:
    'id,slug,title,excerpt,body,body_html,author_id,category_id,cover_image_url,status,published_at,scheduled_for,reading_minutes,version,created_at,updated_at',
  orderBy: { column: 'updated_at', ascending: false },
  searchColumn: 'slug',
  filterableColumns: ['category_id', 'author_id'],
  createSchema: PostWriteSchema,
  updateSchema: PostUpdateSchema,
  toRow: (raw) => {
    // Admin v2 U8b (D12): `body: null` is an editor nobody touched (a post that holds only
    // body_html, as the seed's do, loads an empty editor, and a full save sends null), so it
    // is dropped: neither `body` nor the derived `body_html` is written, and the stored
    // article stays. An emptied editor sends a document, never null, so it still clears.
    const input = untouchedBody(raw as Input);
    const values = publishStamp(withBodyHtml(pick(input, POST_KEYS), input));
    const body = input['body'] as Partial<LocalizedDoc> | undefined;
    // Reading time is DERIVED, never authored: an editor-supplied number drifts from
    // the body the moment anyone edits it, and it is user-visible.
    return body?.en ? { ...values, reading_minutes: readingMinutes(body.en) } : values;
  },
  fields: fieldsOf(POST_KEYS, { ...STAMPED, body: ['body_html', 'reading_minutes'] }),
  statusOf: (input) => statusOf(input as Input),
  assertPublishable: async (row, { auth, sb, db }) => {
    requireBilingual(row, 'title', 'Post title');
    // CLAUDE.md Pillar 3: "E-E-A-T author pages — no anonymous authorship". A published
    // post with a null author is the exact thing that rule forbids, so it is refused
    // here rather than being allowed to reach the JSON-LD builder and emit an Article
    // with no `author`.
    if (!row['author_id']) {
      throw new ValidationError('a published post must have an author (E-E-A-T)', 'authorId');
    }
    // Admin v2 U8b (D11): and that author must be PUBLISHED. The public page embeds its
    // author through anon's RLS on team_members (published rows only), so a draft or
    // archived author renders the post with no author and an Article with none. One read,
    // under the caller's RLS, tenant-scoped; a member it cannot see counts as unpublished. A
    // publish and its dry run (Admin v2 R6) read through their database (`db`, the state the
    // release leaves behind), so a team member published in the same release counts; a save
    // while releases are off reads live, as the poster rule does (portfolio.ts).
    await requirePublishedAuthor({ sb, auth, db }, String(row['author_id']));
  },
};

/** A save's input with an untouched rich text (`body: null`) taken out (D12). */
export function untouchedBody(input: Input): Input {
  if (input['body'] !== null) return input;
  const { body: _untouched, ...rest } = input;
  return rest;
}

/** Refuses a publish whose author is not a published team member of the tenant (D11). */
export async function requirePublishedAuthor(
  ctx: { sb: SupabaseClient; auth: Pick<AuthContext, 'tenantId'>; db?: OverlayDb | undefined },
  authorId: string,
): Promise<void> {
  const db = ctx.db ?? liveDb(ctx.sb, ctx.auth);
  const member = await db.first('team_members', { columns: 'status', eq: { id: authorId } });
  if (member?.['status'] !== 'published') {
    throw new ValidationError('the author must be a published team member', 'authorId');
  }
}
