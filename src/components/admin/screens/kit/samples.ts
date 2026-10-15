import type { FieldDef } from '@/lib/admin/uiSchema';

// The component kit screen's made-up data (Admin v2 F4b, /admin/kit): shared by the page,
// its island and tests/admin/kit.e2e.ts, so the browser test asserts the same names the
// screen draws. Nothing here is real content and nothing is saved.

/** The island's tabs, and the query parameter they keep in step (`?tab=`). */
export const KIT_TAB_PARAM = 'tab';
export const KIT_TAB_IDS = ['content', 'seo', 'media'] as const;
export type KitTab = (typeof KIT_TAB_IDS)[number];

/** The sortable list's sections, in their first order. */
export const KIT_SECTIONS = [
  { id: 'hero', label: 'Hero' },
  { id: 'services', label: 'Services' },
  { id: 'work', label: 'Selected work' },
  { id: 'clients', label: 'Clients' },
  { id: 'contact', label: 'Say hello' },
] as const;

/** The two-column board: widgets in a left and a right column. */
export const KIT_COLUMNS = {
  left: [
    { id: 'visits', label: 'Visits' },
    { id: 'inquiries', label: 'New inquiries' },
  ],
  right: [
    { id: 'health', label: 'Site health' },
    { id: 'drafts', label: 'Drafts waiting' },
  ],
} as const;

/** The list inside the sample drawer (a list reordered in a modal dialog is still heard). */
export const KIT_DRAWER_ITEMS = [
  { id: 'pinned', label: 'Pinned pages' },
  { id: 'activity', label: 'Recent activity' },
  { id: 'shortcuts', label: 'Shortcuts' },
] as const;

export interface KitRow {
  id: string;
  title: string;
  status: 'draft' | 'scheduled' | 'published' | 'archived';
  views: number;
}

const STATUSES: readonly KitRow['status'][] = ['published', 'draft', 'scheduled', 'archived'];

/** The data table's rows: 60 made-up entries, read a page at a time like a server list. */
export const KIT_ROWS: readonly KitRow[] = Array.from({ length: 60 }, (_, i) => ({
  id: `kit-${i + 1}`,
  title: `Sample entry ${i + 1}`,
  status: STATUSES[i % STATUSES.length] ?? 'draft',
  views: (i + 1) * 137,
}));

// ---- The field kit v2 (Admin v2 F5a): every field kind on made-up values ----

/** The sample editor's fields: every kind the field kit draws, as an editor declares them. */
export const KIT_FIELDS: readonly FieldDef[] = [
  {
    name: 'title',
    label: 'Sample name',
    kind: 'bilingual',
    required: true,
    maxLength: 60,
    help: 'The heading a visitor sees.',
  },
  { name: 'blurb', label: 'Sample tagline', kind: 'prose' },
  {
    name: 'figure',
    label: 'A figure, in both digit sets',
    kind: 'bilingual',
    help: 'Arabic digits are kept exactly as typed.',
  },
  {
    name: 'visible',
    label: 'Show the sample on the site',
    kind: 'checkbox',
    help: 'Nothing is shown anywhere: this is the kit.',
  },
  {
    name: 'tint',
    label: 'Accent colour',
    kind: 'color',
    color: { swatches: ['#0024BC', '#024CFF', '#0B0D14', '#067647'], contrastWith: '#FFFFFF' },
  },
  {
    name: 'intervalMs',
    label: 'Next slide after',
    kind: 'range',
    range: { min: 2000, max: 12000, step: 500, suffix: ' ms' },
  },
  { name: 'tags', label: 'Sample tags', kind: 'tags', maxItems: 5 },
  {
    name: 'keywords',
    label: 'Keywords',
    kind: 'chips',
    maxItems: 8,
    chips: { bilingual: true, maxLength: 40 },
  },
  {
    name: 'steps',
    label: 'Step',
    kind: 'repeater',
    maxItems: 4,
    itemFields: [
      { name: 'title', label: 'Title', kind: 'bilingual', required: true },
      { name: 'text', label: 'Text', kind: 'prose' },
    ],
  },
  { name: 'posterMediaId', label: 'Sample poster', kind: 'media' },
  { name: 'body', label: 'Sample body', kind: 'richtext' },
  {
    name: 'status',
    label: 'Sample status',
    kind: 'select',
    options: [
      { value: 'draft', label: 'Draft' },
      { value: 'published', label: 'Published' },
    ],
  },
];

const paragraph = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** Their first values: the Arabic name left empty, so the "missing" cue shows. */
export const KIT_FIELD_VALUES: Readonly<Record<string, unknown>> = {
  title: { en: 'Sample entry', ar: '' },
  blurb: { en: 'A line about the sample.', ar: '' },
  figure: { en: '0123456789', ar: '٠١٢٣٤ ۵۶۷۸۹' },
  visible: false,
  tint: '#0024BC',
  intervalMs: 6000,
  tags: ['sample', 'kit'],
  keywords: { en: ['brand'], ar: ['هوية'] },
  steps: [
    { title: { en: 'Brief', ar: 'الموجز' } },
    { title: { en: 'Sketch', ar: 'الرسم' } },
    { title: { en: 'Deliver', ar: 'التسليم' } },
  ],
  posterMediaId: '',
  body: { en: paragraph('A rich text sample.'), ar: paragraph('نص منسق للعرض.') },
  status: 'draft',
};

/** What "Check the sample fields" pretends the API answered (issues[].path, message). */
export const KIT_FIELD_ISSUES = [
  { path: 'title.ar', message: 'Write the name in Arabic too.' },
  { path: 'steps.1.title.en', message: 'Keep it under 40 characters.' },
  { path: 'tint', message: 'Pick a colour white text can sit on.' },
] as const;
