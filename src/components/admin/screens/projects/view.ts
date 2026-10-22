import { portfolioUi } from '@/lib/admin/ui/portfolio';
import type { EditorTabDef, FieldDef, FieldGroup } from '@/lib/admin/uiSchema';
import { VIEW_FIELD } from './media';

// What a project's editor draws (Admin v2 U6, AV-15; the prototype's /projects/:slug): the
// API's fields (ui/portfolio.ts, which the save sends: its `media` set is one field) with
// `media` replaced by the four role controls of media.ts, labelled as the prototype labels
// them, in five tabs (U8's EditorForm API: Basics | Case study | Breakdown & gallery | SEO |
// Publishing) and U9's cards. Zod-free, like every editor descriptor. The rules a tabbed
// editor's config must keep (every field in exactly one field tab, no SEO panel name) are
// held by tests/lib/projectEditor.spec.ts with editorTabs.ts validateTabs.

const api = new Map(portfolioUi.fields.map((field) => [field.name, field]));

/** An API field, relabelled for the editor (its name, kind and rules unchanged). */
function from(name: string, label: string, help?: string): FieldDef {
  const field = api.get(name);
  if (!field) throw new Error(`portfolio has no field "${name}"`);
  return { ...field, label, ...(help === undefined ? {} : { help }) };
}

/** The media set's item fields (ui/portfolio.ts), by name: the role controls draw some. */
const mediaItem = new Map(
  (api.get('media')?.itemFields ?? []).map((field) => [field.name, field] as const),
);
const item = (name: string, label: string, help?: string): FieldDef => {
  const field = mediaItem.get(name);
  if (!field) throw new Error(`a portfolio media item has no field "${name}"`);
  return { ...field, label, required: false, ...(help === undefined ? {} : { help }) };
};

/** At most 40 media items in all (PortfolioWriteBase), so no control offers more. */
export const MEDIA_ITEMS_MAX = api.get('media')?.maxItems ?? 40;

export const HERO_FIELD: FieldDef = {
  name: VIEW_FIELD.hero,
  label: 'Hero banner',
  kind: 'object',
  help: 'The banner at the top of the case study: a video window over its picture, or a picture alone. Empty means the poster.',
  itemFields: [
    item('clip', 'Banner video'),
    item('mediaId', 'Banner picture, or the video’s poster'),
  ],
};

export const FINAL_FIELD: FieldDef = {
  name: VIEW_FIELD.final,
  label: 'Final film',
  kind: 'object',
  help: 'The film near the end of the case study, with its poster and the length it shows.',
  itemFields: [
    item('clip', 'Film'),
    item('mediaId', 'Poster'),
    item('durationLabel', 'Length shown (m:ss)', 'For example 1:30.'),
  ],
};

export const BREAKDOWN_FIELD: FieldDef = {
  name: VIEW_FIELD.breakdown,
  label: 'Breakdown',
  kind: 'repeater',
  maxItems: MEDIA_ITEMS_MAX,
  help: 'Sketches, behind the scenes and process: each a picture (or a video with its poster) and a caption.',
  itemFields: [
    { ...item('breakdownKind', 'Kind'), required: true },
    item('layout', 'Size'),
    item('mediaId', 'Picture, or the video’s poster'),
    item('clip', 'Video (optional)'),
    item('caption', 'Caption'),
  ],
};

export const GALLERY_FIELD: FieldDef = {
  name: VIEW_FIELD.gallery,
  label: 'Gallery',
  kind: 'gallery',
  maxItems: MEDIA_ITEMS_MAX,
  help: 'The square grid at the end of the case study. Order follows the grid.',
  itemFields: api.get('media')?.itemFields?.filter((f) => f.name !== 'role') ?? [],
};

/** Every field the editor draws, the four media controls in place of the one set. */
export const PROJECT_FIELDS: readonly FieldDef[] = [
  from('title', 'Name'),
  from('projectType', 'Type', 'For example “Brand film” or “Rebrand”. Required to publish.'),
  from('teaser', 'One line description', 'Under the project on Our Work and All projects. Empty means the overview.'),
  from('slug', 'Link (slug)'),
  from('sectorId', 'Sector'),
  from('clientId', 'Client'),
  from('year', 'Year'),
  from('serviceIds', 'Services'),
  from('keywords', 'Keywords on the project page'),
  from('posterMediaId', 'Poster (card image)'),
  from('preview', 'Card clip'),
  HERO_FIELD,
  from('lead', 'Lead sentence'),
  from('summary', 'Overview'),
  from('goal', 'The goal'),
  from('result', 'The result'),
  from('scope', 'Scope of work'),
  from('results', 'Result numbers'),
  FINAL_FIELD,
  from('body', 'Body (more of the story)'),
  BREAKDOWN_FIELD,
  GALLERY_FIELD,
  from('status', 'Status'),
  from('scheduledFor', 'Scheduled for'),
  from('isFeatured', 'Featured on Our Work'),
  from('sortOrder', 'Order in the catalogue', 'Lower comes first. The Projects list’s Move up and Move down set it.'),
  from('nextPortfolioId', 'Next project'),
  from('isPlaceholder', 'Placeholder (design sample)'),
];

export const PROJECT_GROUPS: readonly FieldGroup[] = [
  {
    id: 'project',
    title: 'Project',
    fields: [
      'title',
      'projectType',
      'teaser',
      'slug',
      'sectorId',
      'clientId',
      'year',
      'serviceIds',
      'keywords',
    ],
    column: 'left',
  },
  {
    id: 'media',
    title: 'Media',
    sub: 'The card, and the banner at the top of the case study.',
    fields: ['posterMediaId', 'preview', VIEW_FIELD.hero],
    column: 'right',
  },
  {
    id: 'story',
    title: 'Story',
    fields: ['lead', 'summary', 'goal', 'result', 'scope'],
    column: 'left',
  },
  { id: 'numbers', title: 'Results', fields: ['results'], column: 'right' },
  { id: 'film', title: 'Final film', fields: [VIEW_FIELD.final], column: 'right' },
  { id: 'more', title: 'More', fields: ['body'], collapsible: true },
  { id: 'breakdown', title: 'Breakdown', fields: [VIEW_FIELD.breakdown], column: 'left' },
  { id: 'gallery', title: 'Gallery', fields: [VIEW_FIELD.gallery], column: 'right' },
];

export const PROJECT_TABS: readonly EditorTabDef[] = [
  {
    id: 'basics',
    label: 'Basics',
    icon: 'briefcase',
    fields: [
      'title',
      'projectType',
      'teaser',
      'slug',
      'sectorId',
      'clientId',
      'year',
      'serviceIds',
      'keywords',
      'posterMediaId',
      'preview',
      VIEW_FIELD.hero,
    ],
  },
  {
    id: 'case',
    label: 'Case study',
    icon: 'note',
    fields: ['lead', 'summary', 'goal', 'result', 'scope', 'results', VIEW_FIELD.final, 'body'],
  },
  {
    id: 'breakdown',
    label: 'Breakdown & gallery',
    icon: 'image',
    fields: [VIEW_FIELD.breakdown, VIEW_FIELD.gallery],
  },
  { id: 'seo', label: 'SEO', icon: 'seo', panel: 'seo' },
  {
    id: 'publishing',
    label: 'Publishing',
    icon: 'cal',
    fields: ['status', 'scheduledFor', 'isFeatured', 'sortOrder', 'nextPortfolioId', 'isPlaceholder'],
  },
];
