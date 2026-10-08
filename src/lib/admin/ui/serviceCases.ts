import { NOT_ARCHIVED, PLACEHOLDER_FIELD, SCHEDULED_FIELD, STATUS_FIELD } from './fields';
import type { ResourceUi } from './types';

// Service case studies: the list and the form at /admin/service-cases.
export const serviceCasesUi: ResourceUi = {
  slug: 'service-cases',
  title: 'Service case studies',
  singular: 'Service case study',
  hasStatus: true,
  columns: [
    { key: 'title', label: 'Title', kind: 'bilingual' },
    { key: 'is_placeholder', label: 'Placeholder', kind: 'boolean' },
    { key: 'status', label: 'Status', kind: 'status' },
    { key: 'updated_at', label: 'Updated', kind: 'date' },
  ],
  fields: [
    {
      name: 'serviceId',
      label: 'Service',
      kind: 'relation',
      required: true,
      relation: { resource: 'services', labelKey: 'title', filter: NOT_ARCHIVED },
      help: 'The service page this block appears on. One per service.',
    },
    {
      name: 'portfolioId',
      label: 'Project',
      kind: 'relation',
      relation: { resource: 'portfolio', labelKey: 'title', filter: NOT_ARCHIVED },
      help: 'The case study it links to. Its client and industry are the block’s chips; a client not cleared for disclosure shows as “Confidential client”.',
    },
    { name: 'title', label: 'Title', kind: 'bilingual', required: true },
    {
      name: 'context',
      label: 'Where they were',
      kind: 'bilingual',
      nullable: true,
      help: 'The situation before the work, a sentence or two.',
    },
    {
      name: 'problems',
      label: 'The problem, and what we did',
      kind: 'repeater',
      maxItems: 6,
      help: 'The design shows three rows.',
      itemFields: [
        { name: 'problem', label: 'The problem', kind: 'bilingual', required: true },
        { name: 'solution', label: 'What we did', kind: 'bilingual', required: true },
      ],
    },
    {
      name: 'results',
      label: 'Results',
      kind: 'repeater',
      maxItems: 4,
      help: 'Figures only when they are real. A placeholder figure (XX) cannot be published.',
      itemFields: [
        { name: 'value', label: 'Figure', kind: 'text', required: true, help: 'e.g. 4, +27%' },
        { name: 'label', label: 'What it measures', kind: 'bilingual', required: true },
      ],
    },
    PLACEHOLDER_FIELD,
    STATUS_FIELD,
    SCHEDULED_FIELD,
  ],
};
