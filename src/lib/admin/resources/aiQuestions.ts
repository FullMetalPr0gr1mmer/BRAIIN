import { AiQuestionUpdateSchema, AiQuestionWriteSchema } from '@schemas/admin';
import type { ResourceConfig } from '../resource';
import { pick, requireBilingual, statusOf, type Input } from './shared';

// AI Style-Finder authoring: the questions.

export const aiQuestionResource: ResourceConfig = {
  table: 'ai_questions',
  entity: 'ai_question',
  writeCap: 'ai.editContent',
  listColumns: 'id,slug,prompt,input_type,status,sort_order,version,updated_at',
  columns:
    'id,slug,prompt,help_text,input_type,options,status,sort_order,version,created_at,updated_at',
  orderBy: { column: 'sort_order', ascending: true },
  searchColumn: 'slug',
  createSchema: AiQuestionWriteSchema,
  updateSchema: AiQuestionUpdateSchema,
  toRow: (input) =>
    pick(input as Input, {
      slug: 'slug',
      prompt: 'prompt',
      helpText: 'help_text',
      inputType: 'input_type',
      options: 'options',
      status: 'status',
      sortOrder: 'sort_order',
    }),
  statusOf: (input) => statusOf(input as Input),
  assertPublishable: (row) => requireBilingual(row, 'prompt', 'Question prompt'),
};
