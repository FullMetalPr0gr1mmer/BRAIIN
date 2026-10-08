import {
  bilingualList,
  NOT_ARCHIVED,
  SCHEDULED_FIELD,
  showreelClip,
  SORT_FIELD,
  STATUS_FIELD,
} from './fields';
import type { ResourceUi } from './types';

// Services: the list and the form at /admin/services.
export const servicesUi: ResourceUi = {
  slug: 'services',
  title: 'Services',
  singular: 'Service',
  hasStatus: true,
  reorder: true,
  columns: [
    { key: 'title', label: 'Title', kind: 'bilingual' },
    { key: 'slug', label: 'Slug' },
    { key: 'status', label: 'Status', kind: 'status' },
    { key: 'sort_order', label: 'Order' },
    { key: 'updated_at', label: 'Updated', kind: 'date' },
  ],
  fields: [
    {
      name: 'slug',
      label: 'Slug',
      kind: 'slug',
      required: true,
      help: 'The page address: /services/<slug>.',
    },
    { name: 'title', label: 'Service name', kind: 'bilingual', required: true },
    {
      name: 'disciplineId',
      label: 'Discipline',
      kind: 'relation',
      relation: { resource: 'disciplines', labelKey: 'name', filter: NOT_ARCHIVED },
      help: 'The group it is listed under (home cards, /services, the inquiry forms). Required to publish.',
    },
    {
      name: 'blurb',
      label: 'Tagline',
      kind: 'prose',
      help: 'The tagline shown under the service name. Also the page’s meta description and search text.',
    },
    {
      name: 'intro',
      label: 'Intro (the “What it is” heading)',
      kind: 'bilingual',
      nullable: true,
      help: 'One sentence, e.g. “A logo is a promise you repeat thousands of times, so we make it count.”',
    },
    { name: 'body', label: 'What it is (body)', kind: 'richtext' },
    {
      name: 'valuePoints',
      label: 'Value we add',
      kind: 'repeater',
      maxItems: 6,
      help: 'The “Why it’s worth it” cards. The design shows three.',
      itemFields: [
        { name: 'title', label: 'Title', kind: 'bilingual', required: true },
        { name: 'text', label: 'Text', kind: 'bilingual', required: true },
      ],
    },
    bilingualList('deliverables', 'What you get', 12, 'The checklist, one line each.'),
    {
      name: 'posterMediaId',
      label: 'Poster',
      kind: 'media',
      help: 'The still behind the hero clip, and the service’s image in the Services explorer.',
    },
    showreelClip(
      'Hero clip',
      'The window of the showreel the page opens with, also played on its explorer row. At most 30 seconds.',
    ),
    {
      name: 'shortTitle',
      label: 'Short title (chips)',
      kind: 'bilingual',
      nullable: true,
      help: 'Shown on filter chips and skill tags where the full title is too long (e.g. “SEO / GEO / AEO”). Empty = the title.',
    },
    {
      name: 'heroVideoUid',
      label: 'Hero video (Cloudflare Stream UID)',
      kind: 'text',
      help: 'Not used yet: the page plays the hero clip above until Stream is provisioned (KAN-20).',
    },
    { name: 'category', label: 'Category', kind: 'text' },
    {
      name: 'isTeaser',
      label: 'Coming-soon teaser',
      kind: 'checkbox',
      help: 'Published + teaser shows a “Coming soon” note: not a fifth status.',
    },
    SORT_FIELD,
    STATUS_FIELD,
    SCHEDULED_FIELD,
  ],
};
