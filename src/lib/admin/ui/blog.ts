import { SCHEDULED_FIELD, STATUS_FIELD } from './fields';
import type { ResourceUi } from './types';

// Blog: the list and the form at /admin/blog.
export const blogUi: ResourceUi = {
  slug: 'blog',
  title: 'Blog',
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
    { name: 'slug', label: 'Slug', kind: 'slug', required: true },
    { name: 'title', label: 'Title', kind: 'bilingual', required: true },
    { name: 'excerpt', label: 'Excerpt', kind: 'prose' },
    { name: 'body', label: 'Body', kind: 'richtext' },
    {
      name: 'authorId',
      label: 'Author (team member id)',
      kind: 'text',
      help: 'Required to publish — E-E-A-T forbids anonymous authorship.',
    },
    { name: 'categoryId', label: 'Category id', kind: 'text' },
    { name: 'coverImageUrl', label: 'Cover image URL', kind: 'url' },
    STATUS_FIELD,
    SCHEDULED_FIELD,
  ],
};
