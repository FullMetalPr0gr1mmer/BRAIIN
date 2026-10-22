import { SCHEDULED_FIELD, STATUS_FIELD } from './fields';
import type { ResourceUi } from './types';

// Creative Knowledge (the blog): the list and the form at /admin/blog. Since Admin v2 U8b the
// editor is in tabs, Content | SEO | Publishing (the first ResourceUi with `tabs`; U5 and U6
// follow): the SEO tab is the shared SEO editor for the post (`seoEntity`), and a published
// post offers "Open on site". The author and the category are pickers, not id boxes; only a
// PUBLISHED team member can be picked as an author, because the public page and its Article
// JSON-LD read the author through anon's published-only fence (resources/blog.ts refuses a
// publish with any other).
export const blogUi: ResourceUi = {
  slug: 'blog',
  title: 'Creative Knowledge',
  singular: 'Post',
  hasStatus: true,
  columns: [
    { key: 'title', label: 'Title', kind: 'bilingual' },
    { key: 'slug', label: 'Slug' },
    { key: 'status', label: 'Status', kind: 'status' },
    { key: 'published_at', label: 'Published', kind: 'date' },
    { key: 'updated_at', label: 'Updated', kind: 'date' },
  ],
  fields: [
    { name: 'title', label: 'Title', kind: 'bilingual', required: true },
    { name: 'slug', label: 'Slug', kind: 'slug', required: true },
    {
      name: 'excerpt',
      label: 'Excerpt',
      kind: 'prose',
      help: 'The short summary on the Creative Knowledge list and in search results.',
    },
    { name: 'body', label: 'Body', kind: 'richtext' },
    {
      name: 'authorId',
      label: 'Author',
      kind: 'relation',
      relation: { resource: 'team', labelKey: 'name', filter: { status: 'published' } },
      help: 'Needed to publish: every post names its author. Only published team members can be picked.',
    },
    {
      name: 'categoryId',
      label: 'Category',
      kind: 'relation',
      relation: { resource: 'categories', labelKey: 'name' },
    },
    {
      name: 'coverImageUrl',
      label: 'Share image (https link)',
      kind: 'url',
      help: 'Used when the post is shared, and as the article’s image for search engines. It is not drawn on the page.',
    },
    STATUS_FIELD,
    SCHEDULED_FIELD,
  ],
  tabs: [
    {
      id: 'content',
      label: 'Content',
      fields: ['title', 'slug', 'excerpt', 'body', 'authorId', 'categoryId', 'coverImageUrl'],
    },
    { id: 'seo', label: 'SEO', panel: 'seo' },
    { id: 'publishing', label: 'Publishing', fields: ['status', 'scheduledFor'] },
  ],
  seoEntity: 'blog_post',
  publicHref: (values) =>
    values['status'] === 'published' && typeof values['slug'] === 'string' && values['slug']
      ? `/creative-knowledge/${values['slug']}`
      : null,
};
