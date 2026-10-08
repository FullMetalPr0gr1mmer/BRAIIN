import { SORT_FIELD, STATUS_FIELD } from './fields';
import type { ResourceUi } from './types';

// Style-Finder questions: the list and the form at /admin/ai-questions.
export const aiQuestionsUi: ResourceUi = {
  slug: 'ai-questions',
  title: 'Style-Finder questions',
  singular: 'Question',
  hasStatus: true,
  reorder: true,
  columns: [
    { key: 'prompt', label: 'Prompt', kind: 'bilingual' },
    { key: 'input_type', label: 'Input' },
    { key: 'status', label: 'Status', kind: 'status' },
  ],
  fields: [
    { name: 'slug', label: 'Slug', kind: 'slug', required: true },
    { name: 'prompt', label: 'Prompt', kind: 'bilingual', required: true },
    { name: 'helpText', label: 'Help text', kind: 'prose' },
    {
      name: 'inputType',
      label: 'Input type',
      kind: 'select',
      options: [
        { value: 'single', label: 'Single choice' },
        { value: 'multi', label: 'Multiple choice' },
        { value: 'scale', label: 'Scale' },
        { value: 'text', label: 'Free text' },
      ],
    },
    { name: 'options', label: 'Options (JSON)', kind: 'json' },
    SORT_FIELD,
    STATUS_FIELD,
  ],
};
