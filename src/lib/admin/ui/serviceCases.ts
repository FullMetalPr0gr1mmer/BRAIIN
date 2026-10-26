import { NOT_ARCHIVED, PLACEHOLDER_FIELD, SCHEDULED_FIELD, STATUS_FIELD } from './fields';
import type { ResourceUi } from './types';

/**
 * At most 5 problems (Admin v2 U5, the prototype's cap; `ADMIN_MAX_CASE_PROBLEMS` in
 * @schemas/content, held equal by tests/lib/servicesArea.spec.ts).
 */
export const SERVICE_CASE_PROBLEMS_MAX = 5;

// Service case studies: the list and the form at /admin/service-cases, and the service
// editor's Case study tab (Admin v2 U5), which draws this form for the service's own row. The
// labels are the prototype's ("Linked project", "Case headline", "Problems we solved").
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
      label: 'Linked project',
      kind: 'relation',
      relation: { resource: 'portfolio', labelKey: 'title', filter: NOT_ARCHIVED },
      help: 'The picture and the “See the full project” link come from here, and so do the client and the sector. A client not cleared to be named shows as “Confidential client”.',
    },
    { name: 'title', label: 'Case headline', kind: 'bilingual', required: true },
    {
      name: 'context',
      label: 'Where they were',
      kind: 'bilingual',
      nullable: true,
      multiline: true,
      help: 'The situation before the work, a sentence or two.',
    },
    {
      name: 'problems',
      label: 'Problems we solved',
      kind: 'repeater',
      maxItems: SERVICE_CASE_PROBLEMS_MAX,
      help: 'The problem, and what we did about it. Three rows work best.',
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
      help: 'The big numbers under the case. Figures only when they are real: a placeholder figure (XX) cannot be published.',
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
