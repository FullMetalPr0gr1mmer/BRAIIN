import { SORT_FIELD, STATUS_FIELD } from './fields';
import type { ResourceUi } from './types';

// Style-Finder styles: the list and the form at /admin/ai-styles. The quiz is not live, so a
// published style is shown nowhere yet (Admin v2 U8a). Traits stay JSON until the quiz's
// logic decides what they mean (U8 D4); the image is a link (D5: a URL column).
export const aiStylesUi: ResourceUi = {
  slug: 'ai-styles',
  title: 'Style-Finder styles',
  singular: 'Style',
  hasStatus: true,
  reorder: true,
  columns: [
    { key: 'name', label: 'Name', kind: 'bilingual' },
    { key: 'slug', label: 'Slug' },
    { key: 'status', label: 'Status', kind: 'status' },
  ],
  fields: [
    { name: 'slug', label: 'Slug', kind: 'slug', required: true },
    { name: 'name', label: 'Name', kind: 'bilingual', required: true },
    { name: 'description', label: 'Description', kind: 'prose' },
    {
      name: 'traits',
      label: 'Traits (advanced)',
      kind: 'json',
      help: 'JSON: each trait a number from 0 to 1, such as {"bold": 0.8}. Nothing reads it yet: the quiz is not built.',
    },
    {
      name: 'imageUrl',
      label: 'Image link',
      kind: 'url',
      help: 'An https link to the picture.',
    },
    SORT_FIELD,
    STATUS_FIELD,
  ],
};
