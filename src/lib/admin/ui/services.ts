import {
  bilingualList,
  NOT_ARCHIVED,
  SCHEDULED_FIELD,
  showreelClip,
  SORT_FIELD,
  STATUS_FIELD,
} from './fields';
import type { ResourceUi } from './types';

/**
 * At most 4 value cards (Admin v2 U5, the prototype's cap; `ADMIN_MAX_VALUE_POINTS` in
 * @schemas/content, which this Zod-free module cannot import: tests/lib/servicesArea.spec.ts
 * holds the two equal).
 */
export const SERVICE_VALUE_CARDS_MAX = 4;

// Services: the editor at /admin/services/[id] (Admin v2 U5, AV-14). /admin/services itself is
// the Services overview (the disciplines, AdminServices), and a discipline's page lists and
// orders its services (AdminDiscipline); the list columns below are what those screens and the
// pickers read (resources/services.ts listColumns).
//
// The editor is in tabs (U8's EditorForm API): Content | Case study | SEO | Leads | Publishing.
// Content holds U9's cards (The service, Deliverables, The value we add, Hero, More). The Case
// study tab is the service's `service_cases` row in its own form, with its own version
// (`panel: 'case'`); SEO is the shared SeoPanel; Leads (`panel: 'leads'`) lists the newest
// inquiries naming the service, for the roles holding leads.manage only. The labels are the
// prototype's ("Hero tagline", "Intro statement", "Explanation").
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
    { name: 'title', label: 'Service name', kind: 'bilingual', required: true },
    {
      name: 'slug',
      label: 'Link (slug)',
      kind: 'slug',
      required: true,
      help: 'The page address: /services/<slug>. Changing it on a live service breaks the old address until a redirect points it here.',
    },
    {
      name: 'disciplineId',
      label: 'Discipline',
      kind: 'relation',
      relation: { resource: 'disciplines', labelKey: 'name', filter: NOT_ARCHIVED },
      help: 'The group it is listed under (home cards, /services, the inquiry forms). Required to publish.',
    },
    {
      name: 'blurb',
      label: 'Hero tagline',
      kind: 'prose',
      help: 'The line under the service name. Also the page’s meta description and search text.',
    },
    {
      name: 'intro',
      label: 'Intro statement',
      kind: 'bilingual',
      nullable: true,
      help: 'The big line under the hero, one sentence. For example: “A logo is a promise you repeat thousands of times, so we make it count.”',
    },
    { name: 'body', label: 'Explanation', kind: 'richtext' },
    bilingualList('deliverables', 'What you get', 12, 'The checklist, one line each.'),
    {
      name: 'valuePoints',
      label: 'Value cards',
      kind: 'repeater',
      maxItems: SERVICE_VALUE_CARDS_MAX,
      help: 'The “Why it’s worth it” cards. Three cards work best.',
      itemFields: [
        { name: 'title', label: 'Title', kind: 'bilingual', required: true },
        { name: 'text', label: 'Text', kind: 'bilingual', required: true, multiline: true },
      ],
    },
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
      help: 'Shown on filter chips and skill tags where the full title is too long (for example “SEO / GEO / AEO”). Empty means the title.',
    },
    {
      name: 'heroVideoUid',
      label: 'Hero video (Cloudflare Stream UID)',
      kind: 'text',
      help: 'Not used yet: the page plays the hero clip above until video hosting is set up.',
    },
    { name: 'category', label: 'Category', kind: 'text' },
    {
      name: 'isTeaser',
      label: 'Coming-soon teaser',
      kind: 'checkbox',
      help: 'Published and a teaser shows a “Coming soon” note: not a fifth status.',
    },
    STATUS_FIELD,
    SCHEDULED_FIELD,
    {
      ...SORT_FIELD,
      help: 'Its place within its discipline. The discipline’s page sets it when you move a service there.',
    },
  ],
  groups: [
    {
      id: 'service',
      title: 'The service',
      fields: ['title', 'slug', 'disciplineId', 'blurb', 'intro', 'body'],
      column: 'left',
    },
    {
      id: 'deliverables',
      title: 'Deliverables',
      sub: 'Shown as a checklist.',
      fields: ['deliverables'],
      column: 'left',
    },
    {
      id: 'value',
      title: 'The value we add',
      sub: 'Three cards work best.',
      fields: ['valuePoints'],
      column: 'right',
    },
    { id: 'hero', title: 'Hero', fields: ['posterMediaId', 'clip'], column: 'right' },
    {
      id: 'more',
      title: 'More',
      sub: 'Rarely changed.',
      fields: ['shortTitle', 'heroVideoUid', 'category', 'isTeaser'],
      collapsible: true,
    },
  ],
  tabs: [
    {
      id: 'content',
      label: 'Content',
      icon: 'type',
      fields: [
        'title',
        'slug',
        'disciplineId',
        'blurb',
        'intro',
        'body',
        'deliverables',
        'valuePoints',
        'posterMediaId',
        'clip',
        'shortTitle',
        'heroVideoUid',
        'category',
        'isTeaser',
      ],
    },
    { id: 'case', label: 'Case study', icon: 'briefcase', panel: 'case' },
    { id: 'seo', label: 'SEO', icon: 'seo', panel: 'seo' },
    { id: 'leads', label: 'Leads', icon: 'inbox', panel: 'leads' },
    {
      id: 'publishing',
      label: 'Publishing',
      icon: 'cal',
      fields: ['status', 'scheduledFor', 'sortOrder'],
    },
  ],
  seoEntity: 'service',
  publicHref: (values) =>
    values['status'] === 'published' && typeof values['slug'] === 'string' && values['slug']
      ? `/services/${values['slug']}`
      : null,
};
