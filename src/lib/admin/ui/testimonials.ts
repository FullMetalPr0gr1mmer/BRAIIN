import { PLACEHOLDER_FIELD, SCHEDULED_FIELD, SORT_FIELD, STATUS_FIELD } from './fields';
import type { ResourceUi } from './types';

// Testimonials: the list and the form at /admin/testimonials.
export const testimonialsUi: ResourceUi = {
  slug: 'testimonials',
  title: 'Testimonials',
  singular: 'Quote',
  hasStatus: true,
  reorder: true,
  columns: [
    { key: 'author_name', label: 'Author', kind: 'bilingual' },
    { key: 'slug', label: 'Slug' },
    { key: 'is_placeholder', label: 'Placeholder', kind: 'boolean' },
    { key: 'status', label: 'Status', kind: 'status' },
  ],
  fields: [
    { name: 'slug', label: 'Slug', kind: 'slug', required: true },
    {
      name: 'quote',
      label: 'Quote',
      kind: 'bilingual',
      required: true,
      help: 'At most 600 characters per language.',
    },
    { name: 'authorName', label: 'Author', kind: 'bilingual', required: true },
    {
      name: 'authorRole',
      label: 'Title, company',
      kind: 'bilingual',
      nullable: true,
      help: 'Written as it should appear: “Marketing Director, Company”.',
    },
    {
      name: 'placements',
      label: 'Shown on',
      kind: 'multiSelect',
      options: [
        { value: 'home', label: 'Home' },
        { value: 'work', label: 'Our Work' },
      ],
    },
    {
      name: 'portfolioId',
      label: 'Case study',
      kind: 'relation',
      relation: { resource: 'portfolio', labelKey: 'title' },
      help: 'Shown on that case study. One published quote per case study.',
    },
    {
      name: 'clientId',
      label: 'Client',
      kind: 'relation',
      relation: { resource: 'clients', labelKey: 'name' },
    },
    { name: 'avatarMediaId', label: 'Photo', kind: 'media' },
    {
      name: 'consentObtainedAt',
      label: 'Consent obtained',
      kind: 'datetime',
      help: 'When the person agreed to be quoted. Required to publish or schedule — the database refuses otherwise.',
    },
    {
      name: 'consentReference',
      label: 'Consent record',
      kind: 'text',
      help: 'Where the consent is kept (an email, ticket or document id). Never shown on the site.',
    },
    PLACEHOLDER_FIELD,
    SORT_FIELD,
    STATUS_FIELD,
    SCHEDULED_FIELD,
  ],
};
