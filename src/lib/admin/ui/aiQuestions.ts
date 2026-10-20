import { SORT_FIELD, STATUS_FIELD } from './fields';
import type { ResourceUi } from './types';

// Style-Finder questions: the list and the form at /admin/ai-questions. The quiz is not
// live (the endpoint is the 501 stub), so what is published here is shown nowhere yet; the
// screen says so (Admin v2 U8a). A question's options are a repeater (U8a): a short key and
// its words in both languages, at most 20 (AiQuestionWriteSchema).
export const aiQuestionsUi: ResourceUi = {
  slug: 'ai-questions',
  title: 'Style-Finder questions',
  singular: 'Question',
  hasStatus: true,
  reorder: true,
  columns: [
    { key: 'prompt', label: 'Prompt', kind: 'bilingual' },
    { key: 'input_type', label: 'Input', kind: 'option' },
    { key: 'status', label: 'Status', kind: 'status' },
  ],
  fields: [
    {
      name: 'slug',
      label: 'Slug',
      kind: 'slug',
      required: true,
      help: 'A short name for the question, in lowercase letters, numbers and hyphens.',
    },
    { name: 'prompt', label: 'Prompt', kind: 'bilingual', required: true },
    { name: 'helpText', label: 'Help text', kind: 'prose' },
    {
      name: 'inputType',
      label: 'How visitors answer',
      kind: 'select',
      options: [
        { value: 'single', label: 'Single choice' },
        { value: 'multi', label: 'Multiple choice' },
        { value: 'scale', label: 'Scale' },
        { value: 'text', label: 'Free text' },
      ],
    },
    {
      name: 'options',
      label: 'Options',
      kind: 'repeater',
      maxItems: 20,
      help: 'For one choice or several. A scale or free text needs none.',
      itemFields: [
        {
          name: 'value',
          label: 'Value',
          kind: 'text',
          required: true,
          maxLength: 60,
          help: 'A short key, never shown to visitors.',
        },
        { name: 'label', label: 'Label', kind: 'bilingual', required: true },
      ],
    },
    SORT_FIELD,
    STATUS_FIELD,
  ],
};
