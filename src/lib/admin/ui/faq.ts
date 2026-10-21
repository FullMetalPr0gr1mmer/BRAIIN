import { SCHEDULED_FIELD, SORT_FIELD, STATUS_FIELD } from './fields';
import type { ResourceUi } from './types';

// The FAQ (Admin v2 U7): the questions on the Contact page, edited in the collection
// screen's drawer at /admin/faq. The limits are the schema's (packages/schemas/faq.ts).
export const faqUi: ResourceUi = {
  slug: 'faq',
  title: 'FAQ',
  singular: 'Question',
  hasStatus: true,
  reorder: true,
  columns: [
    { key: 'question', label: 'Question', kind: 'bilingual' },
    { key: 'status', label: 'Status', kind: 'status' },
  ],
  fields: [
    {
      name: 'question',
      label: 'Question',
      kind: 'bilingual',
      required: true,
      maxLength: 200,
      help: 'Shown on the Contact page and, word for word, in its FAQ markup for search engines.',
    },
    {
      name: 'answer',
      label: 'Answer',
      kind: 'bilingual',
      multiline: true,
      required: true,
      maxLength: 1200,
      help: 'Answer first, in 40 to 60 words. One paragraph.',
    },
    SORT_FIELD,
    STATUS_FIELD,
    SCHEDULED_FIELD,
  ],
};
