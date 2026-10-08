import type { LocalizedDoc } from '@schemas/tiptap';
import { PostUpdateSchema, PostWriteSchema } from '@schemas/admin';
import { readingMinutes } from '@/lib/content/tiptap';
import { ValidationError } from '../errors';
import type { ResourceConfig } from '../resource';
import { pick, publishStamp, requireBilingual, statusOf, withBodyHtml, type Input } from './shared';

// Blog posts (Creative Knowledge).

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
  toRow: (input) => {
    const values = publishStamp(
      withBodyHtml(
        pick(input as Input, {
          slug: 'slug',
          title: 'title',
          excerpt: 'excerpt',
          body: 'body',
          authorId: 'author_id',
          categoryId: 'category_id',
          coverImageUrl: 'cover_image_url',
          status: 'status',
          scheduledFor: 'scheduled_for',
        }),
        input as Input,
      ),
    );
    const body = (input as Input)['body'] as Partial<LocalizedDoc> | undefined;
    // Reading time is DERIVED, never authored: an editor-supplied number drifts from
    // the body the moment anyone edits it, and it is user-visible.
    return body?.en ? { ...values, reading_minutes: readingMinutes(body.en) } : values;
  },
  statusOf: (input) => statusOf(input as Input),
  assertPublishable: (row) => {
    requireBilingual(row, 'title', 'Post title');
    // CLAUDE.md Pillar 3: "E-E-A-T author pages — no anonymous authorship". A published
    // post with a null author is the exact thing that rule forbids, so it is refused
    // here rather than being allowed to reach the JSON-LD builder and emit an Article
    // with no `author`.
    if (!row['author_id']) {
      throw new ValidationError('a published post must have an author (E-E-A-T)', 'authorId');
    }
  },
};
