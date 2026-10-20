import { FaqItemUpdateSchema, FaqItemWriteSchema } from '@schemas/faq';
import type { ResourceConfig } from '../resource';
import {
  STAMPED,
  fieldsOf,
  pick,
  publishStamp,
  requireBilingual,
  statusOf,
  type Input,
} from './shared';

// The FAQ (Admin v2 U7, migration 0096): the questions on the Contact page and, word for
// word, in its FAQPage JSON-LD. Contact-page content, so pages.write writes it (D2: no new
// capability; its holders are content.publish's, so a writer also publishes), and
// content.archiveDelete (the kernel's default) archives and deletes it. The shape rules
// are the schema's and, for any other write path, the database's CHECK.

const FAQ_KEYS = {
  question: 'question',
  answer: 'answer',
  status: 'status',
  sortOrder: 'sort_order',
  scheduledFor: 'scheduled_for',
};

export const faqResource: ResourceConfig = {
  table: 'faq_items',
  entity: 'faq_item',
  writeCap: 'pages.write',
  readCaps: ['pages.write'],
  listColumns: 'id,question,answer,status,sort_order,scheduled_for,version,updated_at',
  columns:
    'id,question,answer,status,sort_order,published_at,scheduled_for,version,created_at,updated_at',
  orderBy: { column: 'sort_order', ascending: true },
  createSchema: FaqItemWriteSchema,
  updateSchema: FaqItemUpdateSchema,
  constraintFields: {
    faq_items_question_shape: {
      field: 'question',
      message: 'both languages, one line each, at most 200 characters',
    },
    faq_items_answer_shape: {
      field: 'answer',
      message: 'both languages, one paragraph each, at most 1200 characters',
    },
  },
  toRow: (input) => publishStamp(pick(input as Input, FAQ_KEYS)),
  fields: fieldsOf(FAQ_KEYS, STAMPED),
  statusOf: (input) => statusOf(input as Input),
  assertPublishable: (row) => {
    requireBilingual(row, 'question', 'Question');
    requireBilingual(row, 'answer', 'Answer');
  },
};
